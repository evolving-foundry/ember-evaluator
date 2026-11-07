import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerPlatform, PreparationCacheSource } from "../../core/contracts/environment.js";
import { dockerImageName, type DockerImageScope } from "./image-name.js";
import { PINNED_NODE_IMAGE, type DockerCommand } from "./runtime-contract.js";
import { createDockerImagePuller, type DockerImagePull } from "./image-pull.js";
import { applicationCacheRoot } from "../runtime-installation/install.js";
import { acquireRuntimeLock } from "../runtime-installation/lock.js";

type ImageIdentity = { id: string; digests: string[]; platform: string };
type ImageRecord = { schemaVersion: 1; reference: string; digest: string; platform: string; id: string };
type ResolvedImage = { reference: string; pinnedReference: string; id: string };

class BaseImageError extends Error {
  constructor(readonly code: ErrorCode, message: string, cause?: unknown) {
    super(`${code}: ${message}`, { cause });
    this.name = "BaseImageError";
  }
}

async function inspect(command: DockerCommand, reference: string, platform: ContainerPlatform, signal: AbortSignal): Promise<ImageIdentity | null> {
  let output: string;
  try {
    output = (await command(["image", "inspect", "--platform", platform, reference, "--format",
      "[{{json .Id}},{{json .RepoDigests}},{{json .Os}},{{json .Architecture}}]"], { signal })).stdout;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && /no such (?:image|object)|not found/iu.test(error.message)) return null;
    throw error;
  }
  const data: unknown = JSON.parse(output);
  if (!Array.isArray(data) || typeof data[0] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(data[0]) ||
    (data[1] !== null && (!Array.isArray(data[1]) || !data[1].every((item: unknown) => typeof item === "string"))) ||
    typeof data[2] !== "string" || typeof data[3] !== "string")
    throw new BaseImageError("ENV_IMAGE_REFERENCE_INVALID", `Invalid Docker image identity for ${reference}`);
  const actualPlatform = `${data[2]}/${data[3]}`;
  if (actualPlatform !== platform)
    throw new BaseImageError("ENV_ARCH_UNSUPPORTED", `Task image ${reference} is ${actualPlatform}; resolved target is ${platform}`);
  return { id: data[0], digests: data[1] ?? [], platform: actualPlatform };
}

async function readRecord(path: string, reference: string, digest: string, platform: string): Promise<ImageRecord | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new BaseImageError("ENV_IMAGE_REFERENCE_INVALID", "Unsafe Docker image cache record");
  const record: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof record !== "object" || record === null || !("schemaVersion" in record) || record.schemaVersion !== 1 ||
    !("reference" in record) || record.reference !== reference || !("digest" in record) || record.digest !== digest ||
    !("platform" in record) || record.platform !== platform || !("id" in record) ||
    typeof record.id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record.id))
    throw new BaseImageError("ENV_IMAGE_REFERENCE_INVALID", "Invalid Docker image cache record");
  return { schemaVersion: 1, reference, digest, platform, id: record.id };
}

async function writeRecord(path: string, record: ImageRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Keep registry provenance in a local receipt before untagging its registry references. */
export async function resolvePinnedTaskImage(
  command: DockerCommand,
  reference: string,
  platform: ContainerPlatform,
  scope: DockerImageScope | undefined,
  signal: AbortSignal,
  observe?: (source: PreparationCacheSource) => void,
  pull: DockerImagePull = createDockerImagePuller(command),
): Promise<ResolvedImage | null> {
  const match = /^(.*)@(sha256:[a-f0-9]{64})$/u.exec(reference);
  if (!scope || !match || reference === PINNED_NODE_IMAGE || reference.startsWith("ember-evaluator/")) return null;
  const sourceName = match[1]!;
  const digest = match[2]!;
  const colon = sourceName.lastIndexOf(":");
  const repository = colon > sourceName.lastIndexOf("/") ? sourceName.slice(0, colon) : sourceName;
  const sourceReference = `${repository}@${digest}`;
  const contentKey = JSON.stringify([repository, digest, platform]);
  const pinnedReference = dockerImageName("base", contentKey, scope);
  const cache = join(process.env.EVALUATOR_CACHE_DIR ?? applicationCacheRoot(), "docker-images");
  const key = createHash("sha256").update(JSON.stringify([sourceReference, platform])).digest("hex");
  const path = join(cache, `${key}.json`);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const release = await acquireRuntimeLock(join(cache, `${key}.lock`), signal);
  try {
    const record = await readRecord(path, sourceReference, digest, platform);
    const cached = await inspect(command, pinnedReference, platform, signal);
    const verified = (image: ImageIdentity) => image.id === digest || image.digests.some(item => item.endsWith(`@${digest}`)) || record?.id === image.id;
    let admitted = cached && verified(cached) ? { image: cached, reference: pinnedReference } : null;
    if (!admitted && record) {
      const image = await inspect(command, record.id, platform, signal);
      if (image?.id === record.id) admitted = { image, reference: record.id };
    }
    if (!admitted) {
      let localReference = reference;
      let verifiedDigest: string | undefined;
      let image = await inspect(command, reference, platform, signal);
      if (!image) {
        const pulled = await pull(reference, platform, signal);
        localReference = pulled.reference;
        verifiedDigest = pulled.verifiedDigest;
        image = await inspect(command, localReference, platform, signal);
      }
      if (!image || !verified(image) && verifiedDigest !== digest) throw new BaseImageError("ENV_IMAGE_REFERENCE_INVALID", `Task image does not match pinned digest ${digest}`);
      admitted = { image, reference: localReference };
    }
    if (cached && cached.id !== admitted.image.id)
      throw new BaseImageError("ENV_IMAGE_REFERENCE_INVALID", `Evaluator image tag was replaced: ${pinnedReference}`);
    if (!cached) await command(["image", "tag", admitted.reference, pinnedReference], { signal });
    const pinned = await inspect(command, pinnedReference, platform, signal);
    if (!pinned || pinned.id !== admitted.image.id)
      throw new BaseImageError("ENV_IMAGE_REFERENCE_INVALID", `Evaluator image identity changed: ${pinnedReference}`);
    await writeRecord(path, { schemaVersion: 1, reference: sourceReference, digest, platform, id: pinned.id });
    // Remove only source names still pointing to the admitted content. Never remove by ID or force.
    const sources = new Set([sourceReference]);
    if (colon > sourceName.lastIndexOf("/")) sources.add(sourceName);
    for (const source of sources) {
      const image = await inspect(command, source, platform, signal);
      if (image?.id !== pinned.id) continue;
      const current = await inspect(command, pinnedReference, platform, signal);
      if (current?.id !== pinned.id) throw new BaseImageError("ENV_IMAGE_REFERENCE_INVALID", `Evaluator image identity changed: ${pinnedReference}`);
      try { await command(["image", "rm", "--no-prune", source], { signal }); }
      catch (cause) {
        signal.throwIfAborted();
        throw new BaseImageError("CLEANUP_FAILED", `Cannot remove source image reference ${source}; Evaluator image retained at ${pinnedReference}`, cause);
      }
    }
    observe?.(cached ? "image" : "reference");
    return { reference, pinnedReference, id: pinned.id };
  } finally { await release(); }
}
