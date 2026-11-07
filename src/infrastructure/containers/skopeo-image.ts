import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ContainerPlatform } from "../../core/contracts/environment.js";
import type { NetworkAccess } from "../../core/contracts/network.js";
import type { ActivityListener } from "../../core/contracts/activity.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { networkCommand } from "../network/command.js";
import { retryNetworkOperation } from "../network/retry.js";
import { dockerRegistryCredential } from "./registry-auth.js";
import { imageReference, packRegistryImage, type RegistryContentSource } from "./registry-image.js";

export async function downloadSkopeoImage(reference: string, platform: ContainerPlatform, network: NetworkAccess,
  executable: string, directory: string, tag: string, signal: AbortSignal, activity?: ActivityListener) {
  await mkdir(directory, { recursive: true });
  const image = imageReference(reference);
  const credential = await dockerRegistryCredential(image.registry, signal);
  const auth = credential === undefined ? {} : "identityToken" in credential ? { identitytoken: credential.identityToken }
    : { auth: Buffer.from(`${credential.username}:${credential.password}`).toString("base64") };
  const authFile = join(directory, "registry-auth.json");
  await writeFile(authFile, JSON.stringify({ auths: { [image.registry]: auth } }), { mode: 0o600 });
  const secrets = [...network.secrets, ...(credential === undefined ? [] : "identityToken" in credential ? [credential.identityToken] : [credential.password])];
  const [os, architecture] = platform.split("/");
  const globalArgs = ["--override-os", os!, "--override-arch", architecture!, ...(architecture === "arm64" ? ["--override-variant", "v8"] : [])];
  const env = network.environment("host", process.env);
  const execute = async (args: string[], limit = 8 * 1024 * 1024) => retryNetworkOperation(async () => {
    let output;
    try { output = await networkCommand(executable, [...globalArgs, ...args], { signal, env, maxBuffer: limit }); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("Cannot execute skopeo: install it yourself or configure skopeoExecutable");
      throw new Error("Cannot execute skopeo image acquisition");
    }
    if (output.exitCode !== 0) throw new Error(`Skopeo image acquisition failed (${output.exitCode}): ${redactDiagnostic(output.stderr, secrets)}`);
    return Buffer.from(output.stdout);
  }, { signal, context: { phase: "environment", component: "docker", operation: "pull" } });
  const transport = (selector: string) => `docker://${image.registry}/${image.repository}${selector.startsWith("sha256:") ? "@" : ":"}${selector}`;
  const insecure = image.origin.startsWith("http:");
  const layout = join(directory, "skopeo-layout");
  let leafDigest: string | undefined;
  let copied: Promise<void> | undefined;
  const copy = () => copied ??= (async () => {
    if (!leafDigest) throw new Error("Invalid skopeo manifest selection");
    activity?.({ message: "Downloading selected image with skopeo", activity: true });
    await execute(["copy", "--preserve-digests", "--src-authfile", authFile,
      ...(insecure ? ["--src-tls-verify=false"] : []), transport(leafDigest), `oci:${layout}:image`]);
    const manifest = await readFile(join(layout, "blobs", "sha256", leafDigest.slice(7)));
    if (`sha256:${createHash("sha256").update(manifest).digest("hex")}` !== leafDigest)
      throw new Error("Image manifest changed during skopeo copy");
  })();
  const blob = (path: string) => {
    const match = /^blobs\/sha256:([a-f0-9]{64})$/u.exec(path);
    if (!match) throw new Error("Invalid skopeo blob request");
    return join(layout, "blobs", "sha256", match[1]!);
  };
  const source: RegistryContentSource = {
    async read(path, limit) {
      let bytes: Buffer;
      if (path.startsWith("manifests/")) {
        bytes = await execute(["inspect", "--raw", "--authfile", authFile,
          ...(insecure ? ["--tls-verify=false"] : []), transport(path.slice("manifests/".length))], limit);
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (typeof value === "object" && value !== null && !("manifests" in value))
          leafDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      } else { await copy(); bytes = await readFile(blob(path)); }
      if (bytes.length > limit) throw new Error("Image metadata exceeds size limit");
      return { bytes, response: { headers: {} } };
    },
    async get(path) { await copy(); return { body: createReadStream(blob(path)) }; },
  };
  return packRegistryImage(reference, platform, source, directory, tag, signal, activity);
}
