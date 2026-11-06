import { packageManagerCli } from "../network/package-manager.js";
import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import type {
  CommandSpec,
  RuntimeInstallation,
  RuntimeInstallCommand,
  RuntimeLocation,
} from "../../core/contracts/environment.js";
import { canonicalJson } from "../../core/results/run-manifest.js";
import { startLocalProcess } from "../process/local.js";
import { acquireRuntimeLock } from "./lock.js";

export class RuntimeInstallationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "RuntimeInstallationError";
  }
}

export function applicationCacheRoot(): string {
  let base: string;
  if (process.platform === "win32") base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  else if (process.platform === "darwin") base = join(homedir(), "Library", "Caches");
  else base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "ember-evaluator");
}

export function runtimeCacheRoot(): string {
  const configured = process.env.EVALUATOR_RUNTIME_CACHE_DIR;
  if (configured !== undefined) {
    if (!isAbsolute(configured))
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "EVALUATOR_RUNTIME_CACHE_DIR must be an absolute path");
    return configured;
  }
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ember", "r");
  return join(applicationCacheRoot(), "runtimes");
}

function runtimeCacheName(installation: RuntimeInstallation): string {
  const name = installation.cacheName ?? "runtime";
  if (
    typeof name !== "string"
    || !/^[a-z0-9](?:[a-z0-9.-]{0,46}[a-z0-9])?$/u.test(name)
    || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/u.test(name)
  )
    throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "runtime cacheName must be a safe lowercase directory name of at most 48 characters");
  return name;
}

export function runtimeRelativePath(value: string, allowRoot = false): string {
  if (allowRoot && value === ".") return value;
  if (
    !value ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.includes("\\") ||
    /[\0\r\n]/u.test(value) ||
    value.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))
  ) {
    throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", `unsafe runtime relative path: ${value}`);
  }
  return value;
}

function validateCommand(command: RuntimeInstallCommand): void {
  if (
    !command.executable ||
    /[\0\r\n]/u.test(command.executable) ||
    !Array.isArray(command.args) ||
    command.args.some(arg => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "invalid runtime command");
  runtimeRelativePath(command.cwd ?? ".", true);
  for (const [key, value] of Object.entries(command.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0"))
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "invalid runtime environment");
  }
}

type RuntimeFile = { source: string; target: string; digest: string; mode: number };
export type RuntimeInventory = {
  identity: string;
  files: RuntimeFile[];
  commands: RuntimeInstallCommand[];
  probes: RuntimeInstallCommand[];
};

function snapshotCommand(command: RuntimeInstallCommand): RuntimeInstallCommand {
  validateCommand(command);
  return {
    executable: command.executable,
    args: [...command.args],
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    ...(command.env === undefined ? {} : { env: { ...command.env } }),
  };
}

/** Hash generic runtime assets, never bundle-specific schemas or exclusions. */
export async function runtimeInventory(
  installation: RuntimeInstallation,
  platform: string,
  signal: AbortSignal,
): Promise<RuntimeInventory> {
  signal.throwIfAborted();
  const id = installation.id;
  if (!id?.trim()) throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "runtime id is empty");
  if (
    !Array.isArray(installation.files) ||
    !Array.isArray(installation.commands) ||
    !Array.isArray(installation.probes)
  ) {
    throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "runtime files, commands and probes must be arrays");
  }
  const commands = installation.commands.map(snapshotCommand);
  const probes = installation.probes.map(snapshotCommand);
  const sources = installation.files.map(file => ({ source: file.source, target: file.target }));
  const files: RuntimeFile[] = [];
  async function scan(source: string, target: string): Promise<void> {
    signal.throwIfAborted();
    runtimeRelativePath(target);
    if (target === "state" || target.startsWith("state/")) {
      throw new RuntimeInstallationError(
        "ENV_RUNTIME_INSTALL_FAILED",
        "runtime assets cannot overlap the writable state directory",
      );
    }
    const info = await lstat(source);
    if (info.isSymbolicLink())
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", `runtime asset contains a symlink: ${source}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(source)).sort()) await scan(join(source, entry), `${target}/${entry}`);
    } else if (info.isFile()) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(source, { signal })) hash.update(chunk);
      files.push({ source, target, digest: hash.digest("hex"), mode: info.mode & 0o777 });
    } else throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", `runtime asset is not a file or directory: ${source}`);
  }
  for (const file of sources) await scan(file.source, file.target);
  files.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  const targets = new Set<string>();
  for (const file of files) {
    const target = file.target.toLowerCase();
    if (
      targets.has(target) ||
      [...targets].some(existing => target.startsWith(`${existing}/`) || existing.startsWith(`${target}/`))
    ) {
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", `overlapping runtime asset target: ${file.target}`);
    }
    targets.add(target);
  }
  const identity = createHash("sha256")
    .update(
      canonicalJson({
        id,
        platform,
        commands: commands.map(command => ({
          executable: command.executable,
          args: command.args,
          cwd: command.cwd ?? ".",
          env: command.env ?? {},
        })),
        probes: probes.map(command => ({
          executable: command.executable,
          args: command.args,
          cwd: command.cwd ?? ".",
          env: command.env ?? {},
        })),
        files: files.map(({ target, digest, mode }) => ({ target, digest, mode })),
      }),
    )
    .digest("hex");
  return { identity, files, commands, probes };
}

export async function copyRuntimeInventory(
  inventory: RuntimeInventory,
  root: string,
  signal: AbortSignal,
): Promise<void> {
  for (const file of inventory.files) {
    signal.throwIfAborted();
    const destination = join(root, runtimeRelativePath(file.target));
    await mkdir(dirname(destination), { recursive: true });
    await cp(file.source, destination, { dereference: false, force: true });
    if ((await lstat(destination)).isSymbolicLink())
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "runtime asset changed to symlink during copy");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(destination, { signal })) hash.update(chunk);
    if (hash.digest("hex") !== file.digest)
      throw new RuntimeInstallationError("SOURCE_CHANGED", `runtime asset changed: ${file.target}`);
  }
}

export function runtimeCommand(command: RuntimeInstallCommand, root: string): CommandSpec {
  validateCommand(command);
  const expand = (value: string) => value.replaceAll("{root}", root);
  return {
    executable: expand(command.executable),
    args: command.args.map(expand),
    cwd: join(root, command.cwd ?? "."),
    env: Object.fromEntries(Object.entries(command.env ?? {}).map(([key, value]) => [key, expand(value)])),
    inheritEnv: false,
    input: null,
  };
}

async function tail(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let output = Buffer.alloc(0);
  for await (const bytes of stream) output = Buffer.concat([output, bytes]).subarray(-32_768);
  return output.toString("utf8");
}

async function npmCli(): Promise<string> {
  try { return await packageManagerCli("npm"); }
  catch (cause) { throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "cannot resolve the npm CLI beside Node or from PATH", { cause }); }
}

export async function runRuntimeCommand(
  command: RuntimeInstallCommand,
  root: string,
  signal: AbortSignal,
  network?: import("../../core/contracts/network.js").NetworkAccess,
): Promise<void> {
  const localCommand = runtimeCommand(command, root);
  if (network) localCommand.env = network.environment("runtime", localCommand.env);
  // A portable recipe names Node; local execution uses the interpreter already
  // checked by LocalEnvironment, including Windows CreateProcess without PATH search.
  if (localCommand.executable === "node") localCommand.executable = process.execPath;
  if (process.platform === "win32" && localCommand.executable === "npm") {
    localCommand.executable = process.execPath;
    localCommand.args.unshift(await npmCli());
  }
  const processHandle = await startLocalProcess(localCommand, signal, { inheritEnv: false });
  const [stdout, stderr, exit] = await Promise.all([
    tail(processHandle.stdout),
    tail(processHandle.stderr),
    processHandle.done,
  ]);
  signal.throwIfAborted();
  if (exit.code !== 0 || exit.signal !== null)
    throw new RuntimeInstallationError(
      "ENV_RUNTIME_INSTALL_FAILED",
      `${command.executable} exited ${exit.code ?? exit.signal}: ${(stderr || stdout).trim()}`,
    );
}

async function lstatIfPresent(path: string) {
  return lstat(path).catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
}

export async function prepareLocalRuntime(
  installation: RuntimeInstallation,
  cacheRoot: string,
  signal: AbortSignal,
  network?: import("../../core/contracts/network.js").NetworkAccess,
): Promise<RuntimeLocation> {
  const localRoot = installation.localRoot;
  const inventory = await runtimeInventory(
    installation,
    `${process.platform}/${process.arch}/node-${process.versions.node}`,
    signal,
  );
  if (network && localRoot === undefined) inventory.identity = createHash("sha256").update(JSON.stringify([inventory.identity, network.settings.sources])).digest("hex");
  if (localRoot !== undefined) {
    const root = await realpath(localRoot);
    for (const probe of inventory.probes) await runRuntimeCommand(probe, root, signal, network);
    return { root, identity: inventory.identity, persistent: true };
  }
  const name = runtimeCacheName(installation);
  await mkdir(cacheRoot, { recursive: true });
  const base = await realpath(cacheRoot);
  const namedRoot = join(base, name);
  await mkdir(namedRoot, { recursive: true });
  if ((await lstat(namedRoot)).isSymbolicLink())
    throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "managed runtime cache name cannot be a link or junction");
  const directory = inventory.identity.slice(0, 12);
  const root = join(namedRoot, directory);
  const stateRoot = join(namedRoot, `${directory}.state`);
  const release = await acquireRuntimeLock(join(namedRoot, `${directory}.lock`), signal);
  try {
    const rootInfo = await lstatIfPresent(root);
    if (rootInfo?.isSymbolicLink())
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "managed runtime root cannot be a link or junction");
    if (rootInfo && !rootInfo.isDirectory())
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "managed runtime root is not a directory");
    const marker = join(root, ".runtime-ready.json");
    const markerInfo = await lstatIfPresent(marker);
    if (markerInfo?.isSymbolicLink())
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "managed runtime marker cannot be a link");
    if (markerInfo && !markerInfo.isFile())
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "managed runtime marker is not a file");
    const ready = await readFile(marker, "utf8").catch(error => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    if (ready !== inventory.identity) {
      if (rootInfo)
        throw new RuntimeInstallationError(
          "ENV_RUNTIME_INSTALL_FAILED",
          `managed runtime is incomplete or its content identity differs: ${root}; remove it only after confirming no process is using it`,
        );
      await mkdir(root);
      try {
        // Python entry points can embed absolute paths, so install at the final location.
        await copyRuntimeInventory(inventory, root, signal);
        for (const command of inventory.commands) await runRuntimeCommand(command, root, signal, network);
        for (const probe of inventory.probes) await runRuntimeCommand(probe, root, signal, network);
        signal.throwIfAborted();
        await writeFile(marker, inventory.identity, { flag: "wx", mode: 0o600 });
      } catch (error) {
        // root is inside the checked cache directory and was created by this install.
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    } else {
      for (const probe of inventory.probes) await runRuntimeCommand(probe, root, signal, network);
    }
    const stateInfo = await lstatIfPresent(stateRoot);
    if (stateInfo?.isSymbolicLink())
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "managed runtime state cannot be a link or junction");
    if (stateInfo && !stateInfo.isDirectory())
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "managed runtime state is not a directory");
    if (!stateInfo) await mkdir(stateRoot);
    return {
      root: await realpath(root),
      stateRoot: await realpath(stateRoot),
      identity: inventory.identity,
      persistent: true,
    };
  } finally {
    await release();
  }
}
