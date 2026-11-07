import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function owner(path: string): Promise<{ pid: number; host: string; token: string } | null> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Runtime lock cannot be a symlink");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("pid" in value) ||
      !("host" in value) ||
      !("token" in value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.host !== "string" ||
      typeof value.token !== "string"
    )
      throw new Error("Invalid runtime lock ownership");
    return { pid: value.pid, host: value.host, token: value.token };
  } catch (error) {
    if (errno(error, "ENOENT")) return null;
    throw error;
  }
}

function dead(value: Awaited<ReturnType<typeof owner>>): boolean {
  if (!value || value.host !== hostname()) return false;
  try {
    process.kill(value.pid, 0);
    return false;
  } catch (error) {
    return errno(error, "ESRCH");
  }
}

/** Publish complete ownership atomically; never reclaim a live or unknown owner. */
export async function acquireRuntimeLock(path: string, signal: AbortSignal): Promise<() => Promise<void>> {
  signal.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  const candidate = `${path}.${token}.tmp`;
  await writeFile(candidate, JSON.stringify({ pid: process.pid, host: hostname(), token }), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    while (true) {
      signal.throwIfAborted();
      try {
        await link(candidate, path);
        break;
      } catch (error) {
        if (!errno(error, "EEXIST")) throw error;
      }
      if (dead(await owner(path))) {
        // Serializing recovery prevents a second reclaimer deleting a new owner (ABA).
        const release = await acquireRuntimeLock(`${path}.recovery`, signal);
        try {
          if (dead(await owner(path))) await rm(path);
        } finally {
          await release();
        }
      } else await delay(50, undefined, { signal });
    }
  } finally {
    await rm(candidate, { force: true });
  }
  let released = false;
  return async () => {
    if (released) return;
    if ((await owner(path))?.token !== token) throw new Error("Runtime lock ownership changed");
    await rm(path);
    released = true;
  };
}
