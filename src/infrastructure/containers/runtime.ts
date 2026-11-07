import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContainerPlatform, PreparationCacheSource, RuntimeRequirement } from "../../core/contracts/environment.js";
import { workspaceHelperSource } from "../filesystem/workspace-transfer.js";
import { forwarderSource } from "../network/model-gateway.js";
import { DockerBuildCache } from "./build-cache.js";
import { createDockerImagePuller, type DockerImagePull } from "./image-pull.js";
import { CPU_VIEW_PATH, nodeCpuViewSource } from "./cpu.js";
import { dockerImageUser } from "./image-user.js";
import { dockerImageName, type DockerImageScope } from "./image-name.js";

import { PINNED_NODE_IMAGE, DOCKER_PLATFORM, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, type DockerCommand, type PreparedRuntimeImage } from "./runtime-contract.js";

export class DockerRuntimeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`, { cause });
    this.name = "DockerRuntimeError";
  }
}

const helperSource = String.raw`import { constants, createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
const root = "/opt/evaluator/processes";
const [mode, token, ...args] = process.argv.slice(2);
const marker = token ? posix.join(root, token) : "";
const safeToken = value => { if (!/^[a-f0-9-]+$/u.test(value ?? "")) throw new Error("invalid process token"); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const beneath = (base, target) => { const rel = relative(base, target); if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("path escapes allowed root"); return rel; };
async function openBeneath(base, target) {
  const parts = beneath(base, target).split("/").filter(Boolean);
  let current = await open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (let index = 0; index < parts.length; index++) {
      const next = await open("/proc/self/fd/" + current.fd + "/" + parts[index], constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await next.stat();
      if (index < parts.length - 1 && !info.isDirectory()) { await next.close(); throw new Error("download ancestor is not a directory"); }
      await current.close(); current = next;
    }
    return current;
  } catch (error) { await current.close().catch(() => {}); throw error; }
}
async function copyOpen(handle, target) {
  const info = await handle.stat();
  if (info.isFile()) { await mkdir(dirname(target), { recursive: true }); await pipeline(createReadStream("", { fd: handle.fd, autoClose: false }), createWriteStream(target, { flags: "wx", mode: 0o600 })); return; }
  if (!info.isDirectory()) throw new Error("download source is not a regular file or directory");
  await mkdir(target, { recursive: true, mode: 0o700 });
  const names = (await readdir("/proc/self/fd/" + handle.fd)).sort();
  for (const name of names) {
    if (!name || name === "." || name === ".." || name.includes("/")) throw new Error("invalid directory entry");
    const child = await open("/proc/self/fd/" + handle.fd + "/" + name, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await copyOpen(child, posix.join(target, name)); } finally { await child.close(); }
  }
}
if (mode === "idle") { setInterval(() => {}, 3600000); }
else if (mode === "run") {
  safeToken(token); const [executable, ...commandArgs] = args; if (!executable) throw new Error("missing executable");
  await mkdir(root, { recursive: true });
  const child = spawn(executable, commandArgs, { detached: true, stdio: ["inherit", "inherit", "inherit"] });
  if (child.pid === undefined) throw new Error("command did not start");
  // Listeners must attach synchronously, before any await. A fast-exiting
  // child (spawn failure, a /bin/true-like wrapper, cat of a small file) can
  // emit 'error'/'close' while the marker writeFile below yields the loop;
  // if the outcome promise were only constructed there, those events would be
  // lost and the helper would drain with "unsettled top-level await" (exit 13)
  // instead of the child's outcome. The promise is awaited after writeFile,
  // so the listeners are live for the whole marker window.
  const outcome = new Promise((done, fail) => { child.once("error", fail); child.once("close", (code, signal) => done({ code, signal })); });
  await writeFile(marker, String(child.pid), { flag: "wx" });
  let forwarding = false;
  const forward = signal => { if (forwarding) return; forwarding = true; try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  process.on("SIGTERM", () => forward("SIGTERM")); process.on("SIGINT", () => forward("SIGINT"));
  const settled = await outcome;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await rm(marker, { force: true }); process.exitCode = settled.code ?? (settled.signal ? 128 : 1);
} else if (mode === "signal") {
  safeToken(token); const signal = args[0] ?? "SIGTERM";
  let pid; try { pid = Number.parseInt(await readFile(marker, "utf8"), 10); } catch (error) { if (error.code === "ENOENT") process.exit(0); throw error; }
  try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  for (let count = 0; count < 100; count++) { try { process.kill(-pid, 0); await sleep(10); } catch (error) { if (error.code === "ESRCH") break; throw error; } }
} else if (mode === "mkdir") {
  const [allowedRoot, target, kind] = [token, args[0], args[1]]; if (!isAbsolute(allowedRoot) || !isAbsolute(target)) throw new Error("paths must be absolute");
  const rel = relative(allowedRoot, target); if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("target escapes allowed root");
  let current = allowedRoot; await mkdir(current, { recursive: true });
  for (const part of rel.split("/").filter(Boolean).slice(0, -1)) { current = posix.join(current, part); try { const stat = await lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("target parent is unsafe"); } catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(current); } }
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error("target is a symlink"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (kind === "directory") await mkdir(target, { recursive: true });
} else if (mode === "snapshot") {
  safeToken(token); const [allowedRoot, source] = args; const destination = "/opt/evaluator/downloads/" + token;
  await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true, mode: 0o700 });
  const handle = await openBeneath(allowedRoot, source);
  try { await copyOpen(handle, posix.join(destination, "payload")); } finally { await handle.close(); }
} else if (mode === "remove-snapshot") {
  safeToken(token); await rm("/opt/evaluator/downloads/" + token, { recursive: true, force: true });
} else { throw new Error("unknown helper mode"); }
`;

function versionMatches(actual: string, expected: string): boolean {
  const wanted = expected.trim().replace(/^v/u, "");
  if (wanted === "" || wanted === "*" || wanted === "any") return true;
  const normalized = wanted.replace(/\.x$/u, "");
  return actual === normalized || actual.startsWith(`${normalized}.`);
}

function validateRequirements(requirements: RuntimeRequirement[], platform: ContainerPlatform): void {
  for (const requirement of requirements) {
    if (!["any", "*", "linux", platform, platform === "linux/amd64" ? "linux-x64" : "linux-arm64"].includes(requirement.platform)) {
      throw new DockerRuntimeError(
        "ENV_ARCH_UNSUPPORTED",
        `${requirement.name} requires ${requirement.platform}; Docker target is ${platform}`,
      );
    }
    if (requirement.name === "node" && !versionMatches("24.22.1", requirement.version)) {
      throw new DockerRuntimeError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `node ${requirement.version} is required; Docker runtime provides 24.22.1`,
      );
    }
    if (
      (requirement.name === "bash" || requirement.name === "shell") &&
      !versionMatches("5.2.15", requirement.version)
    ) {
      throw new DockerRuntimeError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `bash ${requirement.version} is required; task image must provide bash 5.x`,
      );
    }
    if (requirement.name !== "node" && requirement.name !== "bash" && requirement.name !== "shell") {
      throw new DockerRuntimeError("ENV_RUNTIME_INSTALL_FAILED", `Docker runtime does not provide ${requirement.name}`);
    }
  }
}

type RuntimeImageIdentity = Omit<PreparedRuntimeImage, "runtimes">;
const runtimeDockerfile = [
  "ARG NODE_IMAGE",
  "ARG BASE_IMAGE",
  "FROM ${NODE_IMAGE} AS evaluator_node",
  "FROM ${BASE_IMAGE}",
  "USER 0:0",
  "COPY --from=evaluator_node /usr/local/bin/node /usr/local/bin/node",
  // COPY merges directories; stale nested npm dependencies can shadow the pinned versions.
  "RUN rm -rf /usr/local/lib/node_modules/npm",
  "COPY --from=evaluator_node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm",
  "COPY --chmod=0444 docker-process.mjs /opt/evaluator/docker-process.mjs",
  "COPY --chmod=0444 workspace-transfer.mjs /opt/evaluator/workspace-transfer.mjs",
  "COPY --chmod=0444 model-forwarder.mjs /opt/evaluator/model-forwarder.mjs",
  // Compose starts main before prepare() returns. Its NODE_OPTIONS preload
  // must exist in the image, including when the build process has umask 0077.
  `COPY --chmod=0444 cpu-view.cjs ${CPU_VIEW_PATH}`,
  "RUN mkdir -p /opt/evaluator/processes /opt/evaluator/downloads /opt/evaluator/transfers && chmod 0755 /opt/evaluator && chmod 1777 /opt/evaluator/processes /opt/evaluator/downloads /opt/evaluator/transfers",
  'RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && test "$(uname -m)" = "x86_64" && bash --version | head -1 && /usr/local/bin/node --version && /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js --version',
].join("\n");

export class DockerRuntime {
  private readonly imageCache = new DockerBuildCache<RuntimeImageIdentity>();
  private readonly nodeCache = new DockerBuildCache<string>();
  private nodeReference: string;
  get nodeImage(): string { return this.nodeReference; }
  constructor(
    private readonly command: DockerCommand,
    nodeImage = PINNED_NODE_IMAGE,
    readonly platform: ContainerPlatform = DOCKER_PLATFORM,
    private readonly pullImage: DockerImagePull = createDockerImagePuller(command),
    readonly dockerExecutable = "docker",
  ) {
    if (platform !== "linux/amd64" && platform !== "linux/arm64")
      throw new DockerRuntimeError("ENV_ARCH_UNSUPPORTED", `Unsupported Docker runtime platform: ${String(platform)}`);
    if (nodeImage !== PINNED_NODE_IMAGE)
      throw new DockerRuntimeError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `nodeImage must be the pinned evaluator runtime image ${PINNED_NODE_IMAGE}`,
      );
    this.nodeReference = nodeImage;
  }

  private dockerfile(user: string): string {
    const recipe = this.platform === "linux/amd64" ? runtimeDockerfile : runtimeDockerfile.replace('= "x86_64"', '= "aarch64"');
    return `${recipe}\nUSER ${user}\n`;
  }

  async nodeImageDigest(signal: AbortSignal): Promise<string> {
    return await this.nodeCache.get("node", signal, active => this.resolveNodeImage(active));
  }

  private async resolveNodeImage(signal: AbortSignal): Promise<string> {
    const expected = PINNED_NODE_IMAGE.slice(PINNED_NODE_IMAGE.lastIndexOf("@") + 1);
    let reference = this.nodeImage;
    let verifiedDigest: string | undefined;
    // .Id semantics differ between containerd and classic image stores (manifest
    // digest versus config digest); an image whose RepoDigests carry the pinned
    // digest is the pinned image on either store.
    const inspect = async () =>
      await this.command(["image", "inspect", "--platform", this.platform, reference, "--format", "{{.Id}} {{json .RepoDigests}}"], { signal });
    let inspected;
    try {
      inspected = await inspect();
    } catch {
      signal.throwIfAborted();
      const pulled = await this.pullImage(reference, this.platform, signal);
      reference = pulled.reference;
      verifiedDigest = pulled.verifiedDigest;
      inspected = await inspect();
    }

    const match = /^(\S+) (\[[^\]]*\])$/u.exec(inspected.stdout.trim());
    if (!match)
      throw new DockerRuntimeError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `pinned Node image resolved to unknown; expected ${expected}`,
      );
    const digest = match[1]!;
    const repoDigests = JSON.parse(match[2]!) as string[];
    if (digest !== expected && !repoDigests.some(entry => entry.endsWith(`@${expected}`)) && verifiedDigest !== expected) {
      throw new DockerRuntimeError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `pinned Node image resolved to ${digest}; expected ${expected}`,
      );
    }
    this.nodeReference = reference;
    return digest;
  }

  async prepare(
    baseImage: string,
    requirements: RuntimeRequirement[],
    signal: AbortSignal,
    observe?: (source: PreparationCacheSource) => void,
    scope?: DockerImageScope,
  ): Promise<PreparedRuntimeImage> {
    signal.throwIfAborted();
    validateRequirements(requirements, this.platform);
    const inspected = await this.command(["image", "inspect", "--platform", this.platform, baseImage, "--format", "{{.Id}}"], { signal });
    const baseDigest = inspected.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(baseDigest))
      throw new DockerRuntimeError("ENV_IMAGE_REFERENCE_INVALID", `Docker returned an invalid image ID for ${baseImage}`);
    const nodeDigest = await this.nodeImageDigest(signal);
    // containerd may not register the selected child manifest as an image reference.
    const user = await dockerImageUser(this.command, baseImage, this.platform, signal);
    const runtimeHash = createHash("sha256")
      .update(this.platform)
      .update(this.dockerfile(user))
      .update(helperSource)
      .update(workspaceHelperSource)
      .update(forwarderSource)
      .update(nodeCpuViewSource)
      .digest("hex");
    const key = createHash("sha256").update(JSON.stringify({ baseDigest, nodeDigest, runtimeHash })).digest("hex");
    const tag = dockerImageName(scope ? "runtime" : "solve-runtime", key, scope);
    const image = await this.imageCache.getImage(this.dockerExecutable, tag, signal, buildSignal => this.build(baseImage, baseDigest, tag, user, buildSignal, observe), observe);
    return { ...image, runtimes: this.runtimeMetadata(requirements) };
  }

  private async build(
    baseImage: string,
    baseDigest: string,
    tag: string,
    user: string,
    signal: AbortSignal,
    observe?: (source: PreparationCacheSource) => void,
  ): Promise<RuntimeImageIdentity> {
    try {
      const existing = await this.command(["image", "inspect", "--platform", this.platform, tag, "--format", "{{.Id}}"], { signal });
      const digest = existing.stdout.trim();
      if (/^sha256:[a-f0-9]{64}$/u.test(digest)) { observe?.("image"); return { image: tag, digest, baseDigest }; }
    } catch {}
    signal.throwIfAborted();
    const context = await mkdtemp(join(tmpdir(), "ember-runtime-"));
    try {
      await Promise.all([
        writeFile(join(context, "docker-process.mjs"), helperSource, { mode: 0o600 }),
        writeFile(join(context, "workspace-transfer.mjs"), workspaceHelperSource, { mode: 0o600 }),
        writeFile(join(context, "model-forwarder.mjs"), forwarderSource, { mode: 0o600 }),
        writeFile(join(context, "cpu-view.cjs"), nodeCpuViewSource, { mode: 0o444 }),
        writeFile(join(context, "Dockerfile"), this.dockerfile(user), "utf8"),
      ]);
      await this.command(
        [
          "build",
          "--platform",
          this.platform,
          "--tag",
          tag,
          "--build-arg",
          `NODE_IMAGE=${this.nodeImage}`,
          "--build-arg",
          `BASE_IMAGE=${baseImage}`,
          context,
        ],
        { signal, maxBuffer: 8 * 1024 * 1024 },
      );
      const digest = (await this.command(["image", "inspect", "--platform", this.platform, tag, "--format", "{{.Id}}"], { signal })).stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
        throw new DockerRuntimeError("ENV_IMAGE_REFERENCE_INVALID", `Docker returned an invalid derived image ID for ${tag}`);
      observe?.("built");
      return { image: tag, digest, baseDigest };
    } catch (error) {
      if (error instanceof DockerRuntimeError) throw error;
      throw new DockerRuntimeError("ENV_RUNTIME_INSTALL_FAILED", `cannot add the evaluator runtime to ${baseImage}`, error);
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  }

  private runtimeMetadata(requirements: RuntimeRequirement[]): { name: string; version: string; executable: string }[] {
    return requirements.map(requirement =>
      requirement.name === "node"
        ? { name: "node", version: "24.22.1", executable: "/usr/local/bin/node" }
        : { name: "bash", version: "5.x", executable: "/bin/bash" },
    );
  }
}

export async function prepareRuntimeImage(
  baseImage: string,
  requirements: RuntimeRequirement[],
  signal: AbortSignal,
): Promise<{ image: string; digest: string }> {
  const { runDockerCommand } = await import("./command.js");
  const prepared = await new DockerRuntime((args, options) => runDockerCommand("docker", args, options)).prepare(
    baseImage,
    requirements,
    signal,
  );
  return { image: prepared.image, digest: prepared.digest };
}
