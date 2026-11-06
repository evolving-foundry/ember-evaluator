import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidencePath } from "../../../../core/artifacts/artifacts.js";

/** Git records executable bits, not the coordinator's umask or credential policy. */
export async function writeGitFile(
  root: string, relative: string, bytes: Uint8Array, executable: boolean, signal: AbortSignal,
): Promise<void> {
  const parts = evidencePath(relative).split("/");
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    signal.throwIfAborted();
    directory = join(directory, part);
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o755);
  }
  signal.throwIfAborted();
  const target = join(root, relative);
  const mode = executable ? 0o755 : 0o644;
  await writeFile(target, bytes, { flag: "wx", mode });
  // Creation modes are filtered by umask. chmod restores the admitted Git mode
  // without relaxing the private staging root or the raw download cache.
  await chmod(target, mode);
}
