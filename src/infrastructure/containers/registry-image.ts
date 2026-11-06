import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { retryNetworkOperation } from "../network/retry.js";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createZstdDecompress } from "node:zlib";
import { create as createTar } from "tar";
import { request, type Dispatcher } from "undici";
import { createNetworkDispatcher } from "../network/dispatcher.js";
import type { NetworkProxy } from "../../core/contracts/network.js";
import type { ContainerPlatform } from "../../core/contracts/environment.js";
import type { ActivityListener } from "../../core/contracts/activity.js";
import { dockerRegistryCredential, type RegistryCredential } from "./registry-auth.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ACCEPT = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"].join(", ");
type Descriptor = { digest: string; size: number; mediaType: string };
type ImageReference = { registry: string; origin: string; repository: string; selector: string; digest?: string };
export type DownloadedRegistryImage = { archive: string; sourceDigest: string; configDigest: string; manifestDigest: string };

export function imageReference(value: string): ImageReference {
  if (!value || /[\s\0?#\\]/u.test(value) || value.includes("://")) throw new Error("Invalid registry image reference");
  const [name, digest, extra] = value.split("@");
  if (!name || extra !== undefined || digest !== undefined && !DIGEST.test(digest)) throw new Error("Invalid registry image digest");
  const parts = name.split("/");
  const first = parts[0]!;
  const explicit = parts.length > 1 && (/[.:]/u.test(first) || first === "localhost");
  let registry = explicit ? parts.shift()! : "docker.io";
  if (["index.docker.io", "registry-1.docker.io"].includes(registry)) registry = "docker.io";
  let repository = parts.join("/");
  const colon = repository.lastIndexOf(":");
  const tag = colon > repository.lastIndexOf("/") ? repository.slice(colon + 1) : "latest";
  if (colon > repository.lastIndexOf("/")) repository = repository.slice(0, colon);
  if (registry === "docker.io" && !repository.includes("/")) repository = `library/${repository}`;
  if (!/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/u.test(repository) ||
      !/^[\w][\w.-]{0,127}$/u.test(tag)) throw new Error("Invalid registry image name or tag");
  const host = registry === "docker.io" ? "registry-1.docker.io" : registry;
  let url: URL;
  try { url = new URL(`https://${host}`); } catch { throw new Error("Invalid image registry"); }
  if (url.username || url.password || url.pathname !== "/") throw new Error("Invalid image registry");
  // Match Docker's local-registry behavior; other registries must use verified TLS.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return { registry, origin: `${local ? "http" : "https"}://${url.host}`, repository, selector: digest ?? tag,
    ...(digest === undefined ? {} : { digest }) };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid registry JSON object");
  return value as Record<string, unknown>;
}
function json(bytes: Uint8Array): Record<string, unknown> {
  try { return record(JSON.parse(Buffer.from(bytes).toString("utf8"))); }
  catch { throw new Error("Invalid registry JSON response"); }
}
function descriptor(value: unknown): Descriptor {
  const item = record(value);
  if (typeof item.digest !== "string" || !DIGEST.test(item.digest) || typeof item.mediaType !== "string" ||
      typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0)
    throw new Error("Invalid image content descriptor");
  return { digest: item.digest, size: item.size, mediaType: item.mediaType };
}
function verify(bytes: Uint8Array, digest: string, size?: number): void {
  if (size !== undefined && bytes.length !== size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest)
    throw new Error("Registry image content digest or size mismatch");
}

/** An operation-local client; no environment changes or global HTTP dispatcher. */
class RegistryClient {
  readonly agent: Dispatcher;
  private authorization: string | undefined;
  private credentials: Promise<RegistryCredential | undefined> | undefined;
  constructor(readonly image: ImageReference, proxy: NetworkProxy, private readonly signal: AbortSignal) {
    this.agent = createNetworkDispatcher(proxy);
  }

  private async http(url: URL, headers: Record<string, string>, method: "GET" | "POST" = "GET", body?: string) {
    for (let redirects = 0; ; redirects++) {
      this.signal.throwIfAborted();
      const response = await request(url, { dispatcher: this.agent, method, headers, signal: this.signal,
        headersTimeout: 60_000, bodyTimeout: 60_000, ...(body === undefined ? {} : { body }) }).catch((error: unknown) => {
          this.signal.throwIfAborted();
          const cause: unknown = error instanceof Error ? error.cause : undefined;
          const candidate = typeof error === "object" && error !== null && "code" in error ? error.code
            : typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
          const code = typeof candidate === "string" && /^[A-Z_0-9/-]+$/u.test(candidate) ? candidate
            : error instanceof TypeError && error.message === "Invalid URL" ? "INVALID_URL" : error instanceof Error ? error.name : "NETWORK_ERROR";
          throw new Error(`Registry request to ${url.hostname} failed (${code})`);
        });
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response;
      const location = response.headers.location;
      await response.body.dump();
      if (redirects >= 5 || typeof location !== "string") throw new Error("Invalid registry redirect");
      const next = new URL(location, url);
      if (next.username || next.password || next.protocol !== "https:" && !(next.protocol === "http:" && url.protocol === "http:"))
        throw new Error("Unsafe registry redirect");
      if (next.origin !== url.origin) {
        if (body !== undefined) throw new Error("Unsafe registry authentication redirect");
        // ProxyAgent may add Host to the supplied headers. A redirected CDN needs
        // its own Host/SNI as well as removal of registry authorization.
        headers = { ...headers };
        delete headers.authorization;
        delete headers.host;
        delete headers.Host;
      }
      url = next;
    }
  }

  private async authenticate(challenge: string): Promise<void> {
    this.credentials ??= dockerRegistryCredential(this.image.registry, this.signal);
    const credential = await this.credentials;
    if (/^Basic\b/iu.test(challenge)) {
      if (!credential || !("username" in credential)) throw new Error("Registry requires Docker login credentials");
      this.authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
      return;
    }
    if (!/^Bearer\b/iu.test(challenge)) throw new Error("Unsupported registry authentication challenge");
    const params = new Map([...challenge.matchAll(/([a-z_]+)="([^"\r\n]*)"/giu)].map(m => [m[1]!.toLowerCase(), m[2]!]));
    const realm = params.get("realm");
    if (!realm) throw new Error("Registry authentication realm is missing");
    const url = new URL(realm);
    if (url.username || url.password || url.protocol !== "https:" && !(this.image.origin.startsWith("http:") && url.origin === this.image.origin))
      throw new Error("Unsafe registry authentication realm");
    const service = params.get("service");
    const scope = `repository:${this.image.repository}:pull`;
    const headers: Record<string, string> = {};
    let method: "GET" | "POST" = "GET";
    let body: string | undefined;
    if (credential && "identityToken" in credential) {
      method = "POST";
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.identityToken,
        scope, service: service ?? "", client_id: "ember-evaluator" }).toString();
    } else {
      if (service) url.searchParams.set("service", service);
      url.searchParams.set("scope", scope);
      if (credential) headers.authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
    }
    const response = await this.http(url, headers, method, body);
    if (response.statusCode !== 200) { await response.body.dump(); throw new Error(`Registry token request failed (HTTP ${response.statusCode})`); }
    const data = json(await this.limitedBody(response.body, 1024 * 1024));
    const token = data.token ?? data.access_token;
    if (typeof token !== "string" || !token || /[\r\n]/u.test(token)) throw new Error("Invalid registry authentication token");
    this.authorization = `Bearer ${token}`;
  }

  async get(path: string) {
    const url = new URL(`/v2/${this.image.repository}/${path}`, this.image.origin);
    const headers = () => ({ accept: ACCEPT, ...(this.authorization ? { authorization: this.authorization } : {}) });
    let response = await this.http(url, headers());
    if (response.statusCode === 401) {
      const challenge = response.headers["www-authenticate"];
      await response.body.dump();
      if (typeof challenge !== "string") throw new Error("Registry authentication challenge is missing");
      await this.authenticate(challenge);
      response = await this.http(url, headers());
    }
    if (response.statusCode !== 200) { await response.body.dump(); throw new Error(`Registry request failed (HTTP ${response.statusCode})`); }
    return response;
  }

  async read(path: string, limit: number) {
    return retryNetworkOperation(async () => {
      const response = await this.get(path);
      const bytes = await this.limitedBody(response.body, limit);
      return { response, bytes };
    }, { signal: this.signal, context: { phase: "environment", operation: "pull" } });
  }

  async limitedBody(body: AsyncIterable<Uint8Array> & { destroy(error?: Error): unknown }, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (size > limit) { body.destroy(); throw new Error("Registry response exceeds its size limit"); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

export interface RegistryContentSource {
  read(path: string, limit: number): Promise<{ bytes: Buffer; response: { headers: Record<string, string | string[] | undefined> } }>;
  get(path: string): Promise<{ body: Readable }>;
}

export function mirrorImageReference(reference: string, mirrors: Readonly<Record<string, string>>): string {
  const image = imageReference(reference);
  const mirror = mirrors[image.registry];
  if (!mirror) return reference;
  const name = reference.split("@")[0]!;
  const tag = image.digest && name.lastIndexOf(":") > name.lastIndexOf("/") ? name.slice(name.lastIndexOf(":")) : "";
  return `${new URL(mirror).host}/${image.repository}${tag}${image.digest ? "@" : ":"}${image.selector}`;
}

/** Docker-save drops compressed registry layers; prove its config against the original manifest chain. */

export async function downloadRegistryImage(reference: string, platform: ContainerPlatform, proxy: NetworkProxy,
  directory: string, tag: string, signal: AbortSignal, activity?: ActivityListener): Promise<DownloadedRegistryImage> {
  const client = new RegistryClient(imageReference(reference), proxy, signal);
  try { return await packRegistryImage(reference, platform, client, directory, tag, signal, activity); }
  finally { await client.agent.destroy(); }
}

/** Verify OCI bytes from either registry implementation before producing a Docker archive. */
export async function packRegistryImage(reference: string, platform: ContainerPlatform, client: RegistryContentSource,
  directory: string, tag: string, signal: AbortSignal, activity?: ActivityListener): Promise<DownloadedRegistryImage> {
  signal.throwIfAborted();
  const image = imageReference(reference);
  const blobs = join(directory, "blobs", "sha256");
  const entries = new Set<string>();
  const blobPath = (digest: string) => join(blobs, digest.slice(7));
  const blobName = (digest: string) => `blobs/sha256/${digest.slice(7)}`;
  try {
    await mkdir(blobs, { recursive: true });
    let selected: Descriptor | undefined;
    let manifest: Record<string, unknown>;
    let manifestDigest: string;
    let sourceDigest: string | undefined;
    for (let depth = 0; ; depth++) {
      if (depth > 4) throw new Error("Registry manifest nesting is too deep");
      const { response, bytes } = await client.read(`manifests/${selected?.digest ?? image.selector}`, 8 * 1024 * 1024);
      manifestDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (selected) verify(bytes, selected.digest, selected.size);
      else if (image.digest) verify(bytes, image.digest);
      const advertised = response.headers["docker-content-digest"];
      if (typeof advertised === "string") verify(bytes, advertised);
      sourceDigest ??= manifestDigest;
      await writeFile(blobPath(manifestDigest), bytes);
      entries.add(blobName(manifestDigest));
      manifest = json(bytes);
      if (manifest.schemaVersion !== 2) throw new Error("Unsupported registry image schema");
      if (!Array.isArray(manifest.manifests)) break;
      const [os, architecture] = platform.split("/");
      const candidates = manifest.manifests.map(record).filter(item => {
        const p = record(item.platform ?? {});
        return p.os === os && p.architecture === architecture && (p.variant === undefined || p.variant === "v8");
      });
      if (candidates.length !== 1) throw new Error(`Image index does not select exactly one ${platform} image`);
      selected = descriptor(candidates[0]);
    }
    const config = descriptor(manifest.config);
    const { bytes: configBytes } = await client.read(`blobs/${config.digest}`, 16 * 1024 * 1024);
    verify(configBytes, config.digest, config.size);
    const settings = json(configBytes);
    if (`${String(settings.os)}/${String(settings.architecture)}` !== platform) throw new Error("Registry image platform does not match the requested platform");
    const rootfs = record(settings.rootfs);
    if (rootfs.type !== "layers" || !Array.isArray(rootfs.diff_ids))
      throw new Error("Invalid image root filesystem configuration");
    const diffIds = rootfs.diff_ids.map((value: unknown) => {
      if (typeof value !== "string" || !DIGEST.test(value)) throw new Error("Invalid image root filesystem digest");
      return value;
    });
    if (!Array.isArray(manifest.layers) || manifest.layers.length !== diffIds.length) throw new Error("Image layer count differs from root filesystem configuration");
    await writeFile(blobPath(config.digest), configBytes);
    entries.add(blobName(config.digest));
    const layers = manifest.layers.map(descriptor);
    const dockerLayers: string[] = [];
    // Sequential streaming bounds memory and avoids leaving sibling transfers running after cancellation.
    for (const [index, layer] of layers.entries()) {
      signal.throwIfAborted();
      activity?.({ message: `Downloading image layer ${index + 1}/${layers.length}`, activity: true });
      const gz = ["application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.docker.image.rootfs.diff.tar.gzip"].includes(layer.mediaType);
      const zstd = layer.mediaType === "application/vnd.oci.image.layer.v1.tar+zstd";
      if (!gz && !zstd && layer.mediaType !== "application/vnd.oci.image.layer.v1.tar" && layer.mediaType !== "application/vnd.docker.image.rootfs.diff.tar")
        throw new Error("Unsupported image layer media type");
      await retryNetworkOperation(async () => {
        const response = await client.get(`blobs/${layer.digest}`);
        const compressedHash = createHash("sha256");
        let bytes = 0;
        let lastProgress = performance.now();
        const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (bytes > layer.size) { done(new Error("Image layer exceeds declared size")); return; }
          compressedHash.update(chunk);
          if (performance.now() - lastProgress > 500) {
            try { activity?.({ message: `Downloading image layer ${index + 1}/${layers.length}: ${bytes}/${layer.size} bytes`, activity: true }); }
            catch (error) { done(error instanceof Error ? error : new Error("Image progress listener failed")); return; }
            lastProgress = performance.now();
          }
          done(null, chunk);
        } });
        await pipeline(response.body, meter, createWriteStream(blobPath(layer.digest), { mode: 0o600 }), { signal });
        if (bytes !== layer.size || `sha256:${compressedHash.digest("hex")}` !== layer.digest) throw new Error("Image layer digest or size mismatch");
      }, { signal, context: { phase: "environment", operation: "pull" } });
      entries.add(blobName(layer.digest));
      const diffId = diffIds[index];
      const unpacked = `layer-${index}.tar`;
      const hash = createHash("sha256");
      const diffMeter = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk); } });
      const input = createReadStream(blobPath(layer.digest));
      const output = createWriteStream(join(directory, unpacked), { mode: 0o600 });
      if (gz) await pipeline(input, createGunzip(), diffMeter, output, { signal });
      else if (zstd) await pipeline(input, createZstdDecompress(), diffMeter, output, { signal });
      else await pipeline(input, diffMeter, output, { signal });
      if (`sha256:${hash.digest("hex")}` !== diffId) throw new Error("Image layer root filesystem digest mismatch");
      dockerLayers.push(unpacked);
      entries.add(unpacked);
    }
    activity?.({ message: "Packing verified image for Docker import", activity: true });
    const archive = await packDockerImageArchive(directory, tag, manifestDigest, config.digest, dockerLayers, entries, signal);
    return { archive, sourceDigest: sourceDigest ?? manifestDigest, manifestDigest, configDigest: config.digest };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof EvaluatorError && error.code === "NETWORK_FAILURE")
      throw new EvaluatorError("NETWORK_FAILURE", error.message, error.details);
    // Undici can include authenticated URLs in low-level errors; never propagate them.
    if (error instanceof Error && !["TypeError", "RequestAbortedError"].includes(error.name) &&
        /^(?:Invalid |Registry |Image |Unsupported |Unsafe |Cannot |Docker |Packing |Skopeo )/u.test(error.message)) throw error;
    throw new Error("Registry image download failed; check the proxy, registry and credentials");
  }
}

/** Include OCI metadata so containerd and classic image stores import the same verified identity. */
export async function packDockerImageArchive(directory: string, tag: string, manifestDigest: string, configDigest: string,
  layers: string[], entries: Set<string>, signal: AbortSignal): Promise<string> {
  const blobName = (digest: string) => `blobs/sha256/${digest.slice(7)}`;
  const manifest = await readFile(join(directory, blobName(manifestDigest)));
  const mediaType = json(manifest).mediaType;
  await writeFile(join(directory, "manifest.json"), JSON.stringify([{ Config: blobName(configDigest), RepoTags: [tag], Layers: layers }]));
  await writeFile(join(directory, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  const tagged = imageReference(tag);
  const canonicalTag = `${tagged.registry}/${tagged.repository}:${tagged.selector}`;
  await writeFile(join(directory, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{
    mediaType: typeof mediaType === "string" ? mediaType : "application/vnd.oci.image.manifest.v1+json",
    digest: manifestDigest, size: manifest.length,
    annotations: { "io.containerd.image.name": canonicalTag, "org.opencontainers.image.ref.name": canonicalTag },
  }] }));
  for (const entry of ["manifest.json", "oci-layout", "index.json"]) entries.add(entry);
  const archive = join(directory, "image.tar");
  signal.throwIfAborted();
  await pipeline(createTar({ cwd: directory, portable: true }, [...entries]), createWriteStream(archive, { mode: 0o600 }), { signal });
  return archive;
}
