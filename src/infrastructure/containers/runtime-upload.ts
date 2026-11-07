import type { DockerCommand } from "./runtime-contract.js";

export type DockerExecutionOwner = { uid: number; gid: number };

export async function dockerExecutionOwner(
  command: DockerCommand, id: string, user: string | undefined, signal: AbortSignal,
): Promise<DockerExecutionOwner> {
  const { stdout } = await command([
    "exec", ...(user === undefined ? [] : ["--user", user]), id, "/usr/local/bin/node", "-e",
    "console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid()}))",
  ], { signal });
  const owner: unknown = JSON.parse(stdout);
  if (!owner || typeof owner !== "object" || !("uid" in owner) || !("gid" in owner) ||
      typeof owner.uid !== "number" || !Number.isSafeInteger(owner.uid) || owner.uid < 0 ||
      typeof owner.gid !== "number" || !Number.isSafeInteger(owner.gid) || owner.gid < 0)
    throw new Error("Invalid Docker execution owner");
  return { uid: owner.uid, gid: owner.gid };
}

// Only runtime uploads use this helper. Existing task files, private verifier
// material and log mounts retain their own ownership rules.
export const runtimeUploadSource = String.raw`
import { constants } from "node:fs";
import { mkdir, open, readdir } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
const [operation, root, target, kind, ownerJson] = process.argv.slice(1);
const owner = JSON.parse(ownerJson);
if (!["prepare", "complete"].includes(operation) || !["file", "directory"].includes(kind) ||
    !isAbsolute(root) || !isAbsolute(target) ||
    !Number.isSafeInteger(owner.uid) || owner.uid < 0 || !Number.isSafeInteger(owner.gid) || owner.gid < 0)
  throw new Error("Invalid runtime upload");
const rel = relative(root, target);
if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
  throw new Error("Runtime upload must be beneath the state root");
const parts = rel.split("/");
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
async function own(handle, stat) {
  if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
    await handle.chown(owner.uid, owner.gid);
    // chown can clear special mode bits; retain the uploaded permissions.
    if (stat.mode & 0o6000) await handle.chmod(stat.mode & 0o7777);
  }
}
async function visit(handle) {
  const stat = await handle.stat();
  if (!stat.isFile() && !stat.isDirectory()) return;
  if (stat.isDirectory()) {
    for (const name of await readdir("/proc/self/fd/" + handle.fd)) {
      let child;
      try { child = await open("/proc/self/fd/" + handle.fd + "/" + name,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (error.code === "ELOOP") continue; throw error; }
      try { await visit(child); } finally { await child.close(); }
    }
  }
  await own(handle, stat);
}
let handle = await open(root, directoryFlags);
try {
  for (const [index, name] of parts.entries()) {
    const last = index === parts.length - 1;
    const path = "/proc/self/fd/" + handle.fd + "/" + name;
    if (operation === "prepare" && (kind === "directory" || !last)) {
      let created = false;
      try { await mkdir(path, { mode: 0o700 }); created = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const child = await open(path, directoryFlags);
      if (created) {
        try { await own(child, await child.stat()); } catch (error) { await child.close(); throw error; }
      }
      await handle.close(); handle = child;
    } else if (operation === "prepare") {
      // Check an existing final file without admitting symlink destinations.
      try {
        const child = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { if (!(await child.stat()).isFile()) throw new Error("Runtime upload target is not a regular file"); }
        finally { await child.close(); }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    } else {
      const child = await open(path, last
        ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : directoryFlags);
      await handle.close(); handle = child;
    }
  }
  if (operation === "complete") await visit(handle);
} finally { await handle.close(); }
`;

export async function ownDockerRuntimeUpload(
  command: DockerCommand, id: string, operation: "prepare" | "complete",
  root: string, target: string, directory: boolean, owner: DockerExecutionOwner, signal: AbortSignal,
): Promise<void> {
  await command([
    "exec", "--user", "0:0", id, "/usr/local/bin/node", "--input-type=module", "-e", runtimeUploadSource,
    operation, root, target, directory ? "directory" : "file", JSON.stringify(owner),
  ], { signal });
}
