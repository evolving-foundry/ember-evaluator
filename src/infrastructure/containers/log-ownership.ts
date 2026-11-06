import type { DockerCommand } from "./runtime-contract.js";

type LogOwner = { path: string; uid: number; gid: number; mode?: number };

const readOwnersSource = String.raw`
import { constants } from "node:fs";
import { open } from "node:fs/promises";
const owners = [];
for (const path of JSON.parse(process.argv[1])) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); owners.push({ path, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }); }
  finally { await handle.close(); }
}
console.log(JSON.stringify(owners));
`;

/** Only fixed log mounts are admitted; descriptors keep traversal beneath them. */
export const restoreLogOwnersSource = String.raw`
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
const allowed = new Set(["/logs", "/logs/agent", "/logs/verifier"]);
async function restore(handle, uid, gid) {
  const stat = await handle.stat();
  if (!stat.isDirectory() && !stat.isFile()) return;
  if (stat.isDirectory()) {
    for (const name of await readdir("/proc/self/fd/" + handle.fd)) {
      let child;
      try { child = await open("/proc/self/fd/" + handle.fd + "/" + name,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (error.code === "ELOOP") continue; throw error; }
      try { await restore(child, uid, gid); } finally { await child.close(); }
    }
  }
  if (stat.uid !== uid || stat.gid !== gid) await handle.chown(uid, gid);
}
for (const owner of JSON.parse(process.argv[1])) {
  if (!allowed.has(owner.path) || !Number.isSafeInteger(owner.uid) || owner.uid < 0 ||
      !Number.isSafeInteger(owner.gid) || owner.gid < 0) throw new Error("Invalid log ownership receipt");
  const handle = await open(owner.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await restore(handle, owner.uid, owner.gid);
    if (owner.mode !== undefined) {
      if (!Number.isSafeInteger(owner.mode) || owner.mode < 0 || owner.mode > 0o7777) throw new Error("Invalid log mode receipt");
      await handle.chmod(owner.mode);
    }
  } finally { await handle.close(); }
}
`;

export async function captureDockerLogOwnership(
  command: DockerCommand, id: string, paths: string[], signal: AbortSignal,
): Promise<LogOwner[]> {
  if (!paths.length || new Set(paths).size !== paths.length ||
      paths.some(path => !["/logs", "/logs/agent", "/logs/verifier"].includes(path)))
    throw new Error("Invalid Docker log mounts");
  // Capture IDs as seen inside the container so user namespaces map them back
  // to the original host owners. Do this before admitting solver processes.
  const { stdout } = await command(["exec", "--user", "0:0", id, "node", "--input-type=module", "-e",
    readOwnersSource, JSON.stringify(paths)], { signal });
  const owners: unknown = JSON.parse(stdout);
  if (!Array.isArray(owners) || owners.length !== paths.length) throw new Error("Invalid Docker log ownership receipt");
  return owners.map((owner: unknown, index) => {
    if (!owner || typeof owner !== "object" || !("path" in owner) || owner.path !== paths[index] ||
        !("uid" in owner) || typeof owner.uid !== "number" || !Number.isSafeInteger(owner.uid) || owner.uid < 0 ||
        !("gid" in owner) || typeof owner.gid !== "number" || !Number.isSafeInteger(owner.gid) || owner.gid < 0)
      throw new Error("Invalid Docker log ownership receipt");
    if (!("mode" in owner) || typeof owner.mode !== "number" || !Number.isSafeInteger(owner.mode) || owner.mode < 0 || owner.mode > 0o7777)
      throw new Error("Invalid Docker log ownership receipt");
    return { path: String(owner.path), uid: owner.uid, gid: owner.gid, mode: owner.mode };
  });
}

/** Only mount roots beneath the private host attempt admit child UIDs such as postgres. */
export async function makeDockerLogsWritable(command: DockerCommand, id: string, owners: LogOwner[], signal: AbortSignal): Promise<void> {
  const source = String.raw`
import { constants } from "node:fs";
import { open } from "node:fs/promises";
for (const path of JSON.parse(process.argv[1])) {
  if (!["/logs", "/logs/agent", "/logs/verifier"].includes(path)) throw new Error("Invalid Docker log mount");
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.chmod(0o777); } finally { await handle.close(); }
}`;
  await command(["exec", "--user", "0:0", id, "/usr/local/bin/node", "--input-type=module", "-e", source, JSON.stringify(owners.map(owner => owner.path))], { signal });
}

export async function restoreDockerLogOwnership(
  command: DockerCommand, id: string, owners: LogOwner[], signal: AbortSignal,
): Promise<void> {
  await command(["exec", "--user", "0:0", id, "node", "--input-type=module", "-e",
    restoreLogOwnersSource, JSON.stringify(owners)], { signal });
}
