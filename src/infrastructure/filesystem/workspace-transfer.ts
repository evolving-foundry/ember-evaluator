import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { performance } from "node:perf_hooks";
import { list } from "tar";
import type { TransferArtifact, TransferSpec } from "../../core/contracts/environment.js";
import { EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, type DockerCommand } from "../containers/runtime-contract.js";

export const STATE_HELPER = "/opt/evaluator/workspace-transfer.mjs";
export const RESERVED_STATE_ROOTS = [
  "/tests",
  "/environment",
  "/solution",
  "/logs",
  "/opt/evaluator",
  "/opt/evaluator-agent",
  "/proc",
  "/sys",
  "/dev",
  "/usr/local/bin/node",
  "/usr/local/bin/npm",
  "/usr/local/bin/npx",
  "/usr/local/lib/node_modules/npm",
  "/root/.pi",
];
export class WorkspaceTransferError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "WorkspaceTransferError";
  }
}
const fail = (message: string): never => {
  throw new WorkspaceTransferError("TRANSFER_UNSAFE", message);
};
type ArchiveSpec = Extract<TransferSpec, { kind: "workspace-archive" | "artifacts" }>;
function stateRoots(spec: ArchiveSpec): string[] {
  return spec.kind === "artifacts" ? spec.paths : [spec.workdir, ...spec.extraPaths];
}
export function artifactExcluded(relative: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const normalized = pattern;
    // GNU tar exclusions are unanchored; wildcards also match dots and slashes.
    let expression = "";
    for (let index = 0; index < normalized.length; index++) {
      const character = normalized[index];
      if (character === "*") expression += ".*";
      else if (character === "?") expression += ".";
      else if (character === "[") {
        const end = normalized.indexOf("]", index + (normalized[index + 1] === "!" ? 3 : 2));
        if (end < 0) expression += "\\[";
        else {
          const contents = normalized.slice(index + 1, end);
          expression += `[${contents.startsWith("!") ? "^" + contents.slice(1) : contents}]`;
          index = end;
        }
      } else {
        const literal = character === "\\" && index + 1 < normalized.length ? normalized[++index] : character;
        expression += literal?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") ?? "";
      }
    }
    try { return new RegExp(`(?:^|/)${expression}(?:/|$)`, "su").test("./" + relative); }
    catch { return false; } // An invalid bracket range does not match in tar.
  });
}
export function validateTransferSpec(
  spec: TransferSpec,
  workdir: string,
): asserts spec is ArchiveSpec {
  if ((spec.kind !== "workspace-archive" && spec.kind !== "artifacts") || (spec.kind === "workspace-archive" && spec.workdir !== workdir))
    throw new WorkspaceTransferError(
      "TRANSFER_UNSAFE",
      "Transfer must describe this session's complete workspace",
    );
  if (spec.kind === "workspace-archive" && !Array.isArray(spec.extraPaths))
    throw new WorkspaceTransferError("TRANSFER_UNSAFE", "Transfer extraPaths must be an array");
  if (spec.kind === "artifacts" && (!Array.isArray(spec.paths) || !spec.paths.length))
    throw new WorkspaceTransferError("TRANSFER_UNSAFE", "Artifact paths must be a non-empty array");
  const roots = stateRoots(spec);
  if (spec.kind === "artifacts" && spec.services !== undefined && (!spec.services || typeof spec.services !== "object" || Array.isArray(spec.services) ||
      Object.entries(spec.services).some(([root, service]) => !roots.includes(root) || typeof service !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(service) || service === "main")))
    throw new WorkspaceTransferError("TRANSFER_UNSAFE", "Invalid artifact service mapping");
  if (spec.kind === "artifacts" && (spec.optionalPaths !== undefined && (!Array.isArray(spec.optionalPaths) || spec.optionalPaths.some(path => !roots.includes(path)))))
    throw new WorkspaceTransferError("TRANSFER_UNSAFE", "Optional artifact roots must be declared paths");
  if (spec.kind === "artifacts" && spec.excludes !== undefined && (!spec.excludes || typeof spec.excludes !== "object" || Array.isArray(spec.excludes) ||
      Object.entries(spec.excludes).some(([root, patterns]) => !roots.includes(root) || !Array.isArray(patterns) ||
        patterns.some(pattern => typeof pattern !== "string" || !pattern.trim() || /[\0\r\n]/u.test(pattern)))))
    throw new WorkspaceTransferError("TRANSFER_UNSAFE", "Invalid artifact exclusions");
  for (const path of roots)
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path === "/" ||
      /[\\\0]/u.test(path) ||
      posix.normalize(path) !== path ||
      RESERVED_STATE_ROOTS.some(root => {
        if (spec.kind === "artifacts" && root === "/logs" && (path === "/logs/artifacts" || path.startsWith("/logs/artifacts/"))) return false;
        return path === root || path.startsWith(root + "/") || root.startsWith(path + "/");
      })
    )
      throw new WorkspaceTransferError("TRANSFER_UNSAFE", `Unsafe state root: ${path}`);
  for (let i = 0; i < roots.length; i++)
    for (const other of roots.slice(i + 1))
      if (other === roots[i] || other.startsWith(roots[i]! + "/") || roots[i]!.startsWith(other + "/"))
        throw new WorkspaceTransferError("TRANSFER_UNSAFE", "State roots overlap");
}
type Entry = {
  path: string;
  type: "File" | "Directory" | "SymbolicLink";
  mode: number;
  size: number;
  sha256: string | null;
  link: string | null;
};
type SkippedSymlink = { path: string; link: string; reason: string };
type Manifest = {
  version: 1;
  spec: TransferSpec;
  present: boolean[];
  entries: Entry[];
  skippedSymlinks?: SkippedSymlink[];
};
async function digest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}
function entryPath(path: string): string {
  const normalized = path.replace(/\/$/u, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /[\\\0]/u.test(normalized) ||
    normalized.split("/").some(part => !part || part === "." || part === "..") ||
    /^[a-z]:/iu.test(normalized)
  )
    fail(`Unsafe archive path: ${path}`);
  return normalized;
}
// Parent components are unsafe even when lexical normalization stays inside a
// root: an earlier component can itself be a symlink to a shallower directory.
// This same predicate is embedded in the native snapshot helper below.
function unsafeSymlinkReason(link: string): string | null {
  if (!link.length || /[\\\0]/u.test(link)) return "invalid-target";
  if (link.startsWith("/")) return "absolute-target";
  if (link.split("/").includes("..")) return "parent-traversal";
  return null;
}
function safeRelativeSymlink(link: string): boolean {
  return unsafeSymlinkReason(link) === null;
}
export async function inspectWorkspaceArchive(
  artifact: TransferArtifact,
  workdir: string,
  signal: AbortSignal,
): Promise<Manifest> {
  validateTransferSpec(artifact.spec, workdir);
  const spec = artifact.spec;
  signal.throwIfAborted();
  if (!/^[a-f0-9]{64}$/u.test(artifact.sha256) || (await digest(artifact.path, signal)) !== artifact.sha256)
    throw new WorkspaceTransferError("TRANSFER_CHECKSUM_MISMATCH", "Workspace archive digest does not match");
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const links: string[] = [];
  let manifestText: string | null = null;
  let problem: unknown;
  try {
    await list({
      file: artifact.path,
      strict: true,
      onReadEntry(entry) {
        try {
          signal.throwIfAborted();
          const path = entryPath(entry.path);
          if (seen.has(path)) fail(`Duplicate archive entry: ${path}`);
          seen.add(path);
          if (path === "manifest.json") {
            if (entry.type !== "File" || entry.size > 16 * 1024 * 1024) fail("Invalid archive manifest");
            const chunks: Buffer[] = [];
            entry.on("data", data => chunks.push(Buffer.from(data)));
            entry.on("end", () => {
              manifestText = Buffer.concat(chunks).toString("utf8");
            });
            return;
          }
          if (path === "payload" && entry.type === "Directory") {
            entry.resume();
            return;
          }
          const match = /^payload\/(0|[1-9][0-9]*)(?:\/|$)/u.exec(path);
          if (!match || Number(match[1]) >= stateRoots(spec).length)
            fail(`Archive entry outside declared roots: ${path}`);
          if (entry.type !== "File" && entry.type !== "Directory" && entry.type !== "SymbolicLink")
            fail(`Unsupported archive entry: ${entry.type}`);
          const link = entry.type === "SymbolicLink" ? (entry.linkpath ?? "") : null;
          if (link !== null) {
            const root = `payload/${match![1]}`;
            const target = posix.resolve("/", posix.dirname(path), link).slice(1);
            if (!safeRelativeSymlink(link) || !(target === root || target.startsWith(root + "/")) || path === root)
              fail(`Unsafe symlink: ${path}`);
            links.push(path);
          }
          if ((entry.mode ?? 0) & 0o7000) fail(`Special permissions are unsupported: ${path}`);
          const record: Entry = {
            path,
            type: entry.type as Entry["type"],
            mode: (entry.mode ?? 0) & 0o777,
            size: entry.size,
            sha256: null,
            link,
          };
          const hash = createHash("sha256");
          entry.on("data", data => hash.update(data));
          entry.on("end", () => {
            if (record.type === "File") record.sha256 = hash.digest("hex");
          });
          entries.push(record);
        } catch (error) {
          problem ??= error;
          entry.resume();
        }
      },
    });
    if (problem) throw problem;
    signal.throwIfAborted();
    if (manifestText === null) fail("Missing archive manifest");
    const manifest = JSON.parse(manifestText!) as Manifest;
    if (
      manifest.version !== 1 ||
      JSON.stringify(manifest.spec) !== JSON.stringify(spec) ||
      !Array.isArray(manifest.present) ||
      manifest.present.length !== stateRoots(spec).length ||
      manifest.present.some(value => typeof value !== "boolean") ||
      !Array.isArray(manifest.entries)
    )
      fail("Archive manifest does not match transfer specification");
    const order = (a: Entry, b: Entry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (JSON.stringify(entries.sort(order)) !== JSON.stringify(manifest.entries.sort(order)))
      fail("Archive entries do not match manifest");
    for (const entry of entries) {
      const pieces = entry.path.split("/");
      const root = stateRoots(spec)[Number(pieces[1])];
      if (spec.kind === "artifacts" && root && pieces.length > 2 &&
          artifactExcluded(pieces.slice(2).join("/"), spec.excludes?.[root] ?? [])) fail("Archive contains an excluded artifact");
      if (links.some(link => entry.path.startsWith(link + "/"))) fail("Archive traverses a symlink");
      if (!manifest.present[Number(entry.path.split("/")[1])]) fail("Missing root has archive entries");
    }
    manifest.present.forEach((present, index) => {
      if (present !== seen.has(`payload/${index}`)) fail("Root presence does not match archive");
      if (!present && spec.kind === "artifacts" && !spec.optionalPaths?.includes(spec.paths[index]!)) fail("Missing required artifact root");
    });
    if (manifest.skippedSymlinks !== undefined) {
      if (!Array.isArray(manifest.skippedSymlinks)) fail("Invalid skipped symlink list");
      const skipped = new Set<string>();
      const directories = new Set(entries.filter(entry => entry.type === "Directory").map(entry => entry.path));
      for (const item of manifest.skippedSymlinks) {
        if (
          !item ||
          typeof item.path !== "string" ||
          typeof item.link !== "string" ||
          typeof item.reason !== "string" ||
          unsafeSymlinkReason(item.link) !== item.reason
        )
          fail("Invalid skipped symlink record");
        const path = entryPath(item.path);
        if (path !== item.path || seen.has(path) || skipped.has(path) || !directories.has(posix.dirname(path)))
          fail("Skipped symlink does not describe an omitted workspace entry");
        skipped.add(path);
      }
    }
    return manifest;
  } catch (error) {
    if (error instanceof WorkspaceTransferError || signal.aborted) throw error;
    throw new WorkspaceTransferError("TRANSFER_UNSAFE", "Cannot validate workspace archive", error);
  }
}

type StateSession = { id: string; workdir: string; command: DockerCommand };
async function cleanup(session: StateSession, token: string, staging: string, error?: unknown): Promise<void> {
  const failures: unknown[] = [];
  const cleanupSignal = AbortSignal.timeout(60_000);
  const execute = async (args: string[], timeoutMs: number, operation: string) => {
    const started = performance.now();
    try {
      await session.command(args, { signal: AbortSignal.any([cleanupSignal, AbortSignal.timeout(timeoutMs)]) });
    } catch (cause) {
      failures.push(new Error(`${operation} in ${session.id} failed after ${Math.round(performance.now() - started)}ms`, { cause }));
    }
  };
  // A successful PROCESS_HELPER run already reaps its child group and removes
  // the token. Launching another signal helper is only necessary after failure.
  if (error !== undefined) {
    await execute(["exec", session.id, "node", PROCESS_HELPER, "signal", token, "SIGKILL"], 15_000, "stop workspace transfer process");
  }
  // Snapshots preserve read-only task directories for the verifier. Make only
  // the private staging copy removable; never change the source or archive.
  await execute(["exec", session.id, EVALUATOR_NODE_EXECUTABLE, STATE_HELPER, "cleanup", token], 45_000, "remove workspace transfer staging");
  try {
    await rm(staging, { recursive: true, force: true });
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length)
    throw new WorkspaceTransferError(
      "CLEANUP_FAILED",
      "Workspace transfer cleanup failed",
      new AggregateError(error ? [error, ...failures] : failures),
    );
  if (error) throw error;
}
export async function exportWorkspace(
  session: StateSession,
  spec: TransferSpec,
  target: string,
  signal: AbortSignal,
): Promise<TransferArtifact> {
  validateTransferSpec(spec, session.workdir);
  signal.throwIfAborted();
  const token = randomUUID();
  const staging = await mkdtemp(join(tmpdir(), "evaluator-state-"));
  let failure: unknown;
  let result: TransferArtifact | undefined;
  try {
    await session.command(
      [
        "exec",
        session.id,
        "node",
        PROCESS_HELPER,
        "run",
        token,
        "node",
        STATE_HELPER,
        "export",
        token,
        JSON.stringify(spec),
      ],
      { signal },
    );
    const path = join(staging, "state.tar");
    await session.command(["cp", `${session.id}:/opt/evaluator/transfers/${token}/state.tar`, path], { signal });
    result = { path, sha256: await digest(path, signal), spec: structuredClone(spec) };
    const manifest = await inspectWorkspaceArchive(result, session.workdir, signal);
    if (spec.kind === "artifacts") {
      result.warnings = spec.paths.flatMap((root, index) => manifest.present[index] ? [] : [{
        code: "ARTIFACT_COLLECTION_INCOMPLETE",
        message: `Declared artifact is absent: ${root}; continuing to the official verifier`,
      }]);
    }
    if (manifest.skippedSymlinks?.length) {
      const roots = stateRoots(spec);
      result.warnings = [...(result.warnings ?? []), ...manifest.skippedSymlinks.map((item): NonNullable<TransferArtifact["warnings"]>[number] => {
        const [, index, ...parts] = item.path.split("/");
        const root = roots[Number(index)];
        if (root === undefined) return fail("Skipped symlink outside declared roots");
        // Keep raw values until the caller redacts credentials; pre-encoding can
        // hide secrets containing quotes or backslashes from literal matching.
        return {
          code: "TRANSFER_UNSAFE",
          message: `Skipped workspace symlink: ${posix.join(root, ...parts)} -> ${item.link} (${item.reason})`,
        };
      })];
    }
    await mkdir(dirname(target), { recursive: true });
    await copyFile(path, target);
    result.path = target;
  } catch (error) {
    failure =
      error instanceof Error && error.message.includes("Error: TRANSFER_UNSAFE: ")
        ? new WorkspaceTransferError("TRANSFER_UNSAFE", "Source workspace contains an unsafe symlink", error)
        : error;
  }
  await cleanup(session, token, staging, failure);
  return result!;
}
export async function restoreWorkspace(
  session: StateSession,
  artifact: TransferArtifact,
  signal: AbortSignal,
): Promise<void> {
  validateTransferSpec(artifact.spec, session.workdir);
  signal.throwIfAborted();
  const token = randomUUID();
  const staging = await mkdtemp(join(tmpdir(), "evaluator-state-"));
  let failure: unknown;
  let touched = false;
  try {
    const path = join(staging, "state.tar");
    await copyFile(artifact.path, path);
    await inspectWorkspaceArchive({ ...artifact, path }, session.workdir, signal);
    touched = true;
    await session.command(["exec", session.id, "node", STATE_HELPER, "init", token], { signal });
    await session.command(["cp", path, `${session.id}:/opt/evaluator/transfers/${token}/state.tar`], { signal });
    await session.command(
      [
        "exec",
        session.id,
        "node",
        PROCESS_HELPER,
        "run",
        token,
        "node",
        STATE_HELPER,
        "restore",
        token,
        artifact.sha256,
      ],
      { signal },
    );
  } catch (error) {
    failure = error;
  }
  if (touched) await cleanup(session, token, staging, failure);
  else {
    await rm(staging, { recursive: true, force: true });
    if (failure) throw failure;
  }
}

// Runs inside the Linux container. File descriptors anchor snapshots while symlinks
// are copied as links; the host's tar reader validates every entry before extraction.
export const workspaceHelperSource = String.raw`import { constants, createReadStream, createWriteStream } from "node:fs";
import { open, readdir, readlink, symlink, mkdir, chmod, lstat, rm, readFile, writeFile, rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { spawn } from "node:child_process";
const unsafeSymlinkReason = ${unsafeSymlinkReason.toString()};
const stateRoots = ${stateRoots.toString()};
const artifactExcluded = ${artifactExcluded.toString()};
const [mode, token, argument] = process.argv.slice(2);
if (!/^[a-f0-9-]+$/.test(token ?? "")) throw new Error("Invalid state token");
const stage = "/opt/evaluator/transfers/" + token;
const hashFile = async path => { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); };
async function tar(args) { const child = spawn("tar", args, { stdio: ["ignore", "inherit", "inherit"] }); await new Promise((done, fail) => { child.on("error", fail); child.on("close", code => code === 0 ? done() : fail(new Error("tar failed: " + code))); }); }
async function openPath(path) {
  let current = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { for (const part of path.split("/").filter(Boolean)) { const next = await open("/proc/self/fd/" + current.fd + "/" + part, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); await current.close(); current = next; } return current; }
  catch (error) { await current.close(); throw error; }
}
const entries = [];
const skippedSymlinks = [];
async function snapshot(handle, path, target, patterns = [], relative = "") {
  const info = await handle.stat(); const mode = info.mode & 0o777;
  if (info.mode & 0o7000) throw new Error("Special permissions are unsupported");
  if (info.isDirectory()) {
    await mkdir(target, { mode: 0o700 }); entries.push({ path, type: "Directory", mode, size: 0, sha256: null, link: null });
    for (const name of await readdir("/proc/self/fd/" + handle.fd)) {
      const childRelative = relative ? relative + "/" + name : name;
      if (artifactExcluded(childRelative, patterns)) continue;
      const source = "/proc/self/fd/" + handle.fd + "/" + name; const childPath = path + "/" + name; const destination = target + "/" + name;
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) {
        const link = await readlink(source);
        const reason = unsafeSymlinkReason(link);
        if (reason !== null) { skippedSymlinks.push({ path: childPath, link, reason }); continue; }
        await symlink(link, destination); entries.push({ path: childPath, type: "SymbolicLink", mode: 0o777, size: 0, sha256: null, link });
      }
      else { const child = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try { await snapshot(child, childPath, destination, patterns, childRelative); } finally { await child.close(); } }
    }
    await chmod(target, mode);
  } else if (info.isFile()) {
    await pipeline(createReadStream("", { fd: handle.fd, autoClose: false }), createWriteStream(target, { flags: "wx", mode }));
    await chmod(target, mode); entries.push({ path, type: "File", mode, size: (await lstat(target)).size, sha256: await hashFile(target), link: null });
  } else throw new Error("Only regular files, directories and safe symlinks are supported");
}
async function writableStagingDirectories(handle) {
  const info = await handle.stat();
  if (!info.isDirectory()) throw new Error("State staging must be a directory");
  await handle.chmod((info.mode & 0o777) | 0o700);
  for (const name of await readdir("/proc/self/fd/" + handle.fd)) {
    let child;
    try { child = await open("/proc/self/fd/" + handle.fd + "/" + name,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) continue; throw error; }
    try { await writableStagingDirectories(child); } finally { await child.close(); }
  }
}
if (mode === "cleanup") {
  let handle;
  try { handle = await openPath(stage); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (handle) {
    try { await writableStagingDirectories(handle); } finally { await handle.close(); }
    await rm(stage, { recursive: true, force: true });
  }
}
else if (mode === "init") await mkdir(stage, { recursive: true, mode: 0o700 });
else if (mode === "export") {
  const spec = JSON.parse(argument); await mkdir(stage + "/payload", { recursive: true, mode: 0o700 }); const present = [];
  for (const [index, root] of stateRoots(spec).entries()) {
    let handle; try { handle = await openPath(root); } catch (error) { if (error.code === "ENOENT" && (spec.kind !== "artifacts" || (spec.optionalPaths ?? []).includes(root))) { present.push(false); continue; } throw error; }
    present.push(true); try { await snapshot(handle, "payload/" + index, stage + "/payload/" + index, spec.kind === "artifacts" ? spec.excludes?.[root] ?? [] : []); } finally { await handle.close(); }
  }
  await writeFile(stage + "/manifest.json", JSON.stringify({ version: 1, spec, present, entries, skippedSymlinks }));
  await tar(["--create", "--format=posix", "--hard-dereference", "--file", stage + "/state.tar", "--directory", stage, "manifest.json", "payload"]);
} else if (mode === "restore") {
  if (await hashFile(stage + "/state.tar") !== argument) throw new Error("TRANSFER_CHECKSUM_MISMATCH");
  await mkdir(stage + "/unpack"); await tar(["--extract", "--file", stage + "/state.tar", "--directory", stage + "/unpack", "--no-same-owner", "--same-permissions"]);
  const manifest = JSON.parse(await readFile(stage + "/unpack/manifest.json", "utf8"));
  const roots = stateRoots(manifest.spec);
  const skipAbsentArtifact = index => manifest.spec.kind === "artifacts" && !manifest.present[index];
  // Preflight every parent before deleting any base-image state.
  for (const [index, root] of roots.entries()) {
    if (skipAbsentArtifact(index)) continue;
    let path = ""; for (const part of posix.dirname(root).split("/").filter(Boolean)) {
      path += "/" + part; let stat; try { stat = await lstat(path); } catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(path); stat = await lstat(path); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe restore ancestor: " + path);
    }
  }
  // Omitted links may be fixtures already present in the trusted verification
  // image. Retain only an identical existing link, without following it or any
  // ancestor. New, changed and deleted unsafe links remain omitted.
  const inheritedLinks = [];
  for (const item of manifest.skippedSymlinks ?? []) {
    const match = /^payload\/(0|[1-9][0-9]*)\/(.+)$/.exec(item.path);
    if (!match || !roots[Number(match[1])] || match[2].split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid omitted link path");
    const index = Number(match[1]); const relative = match[2]; let parent;
    try {
      parent = await openPath(posix.join(roots[index], posix.dirname(relative)));
      const source = "/proc/self/fd/" + parent.fd + "/" + posix.basename(relative);
      if ((await lstat(source)).isSymbolicLink() && await readlink(source) === item.link) inheritedLinks.push({ index, relative, link: item.link });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw error;
    } finally { if (parent) await parent.close(); }
  }
  for (const [index, root] of roots.entries()) { if (skipAbsentArtifact(index)) continue; await rm(root, { recursive: true, force: true }); if (manifest.present[index]) await rename(stage + "/unpack/payload/" + index, root); }
  for (const item of inheritedLinks) {
    const parent = await openPath(posix.join(roots[item.index], posix.dirname(item.relative)));
    try { await symlink(item.link, "/proc/self/fd/" + parent.fd + "/" + posix.basename(item.relative)); }
    finally { await parent.close(); }
  }
} else throw new Error("Unknown state helper mode");
`;
