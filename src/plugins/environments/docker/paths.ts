import { DockerEnvironmentError } from "../../../infrastructure/containers/error.js";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { RESERVED_STATE_ROOTS } from "../../../infrastructure/filesystem/workspace-transfer.js";


export async function assertLinkFree(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new DockerEnvironmentError("TRANSFER_UNSAFE", `${label} contains a symlink`);
  if (stat.isDirectory()) for (const item of await readdir(path)) await assertLinkFree(join(path, item), label);
}

export function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function containerWorkdir(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  const target = posix.isAbsolute(normalized) ? normalized : posix.resolve("/workspace", normalized);
  const reserved = RESERVED_STATE_ROOTS;
  if (
    value.includes("\0") || target === "/" ||
    reserved.some(root => target === root || target.startsWith(`${root}/`))
  ) {
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", `unsafe Docker workdir: ${target}`);
  }
  return target;
}

export function containerTarget(
  workdir: string,
  value: string,
  runtimeRoots: readonly string[] = [],
): { root: string; target: string } {
  if (value.includes("\0")) throw new DockerEnvironmentError("TRANSFER_UNSAFE", "container path contains NUL");
  const target = posix.isAbsolute(value) ? posix.normalize(value) : posix.resolve(workdir, value.replaceAll("\\", "/"));
  const inWorkspace = target === workdir || target.startsWith(`${workdir}/`);
  const runtimeRoot = runtimeRoots.find(root => target === root || target.startsWith(`${root}/`));
  if (!inWorkspace && runtimeRoot === undefined)
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", "container path escapes the allowed roots");
  return { root: runtimeRoot ?? workdir, target };
}

export function containerFileTarget(workdir: string, value: string, runtimeRoots: readonly string[] = []) {
  const destination = containerTarget(workdir, value, runtimeRoots);
  // A cwd may contain runtime directories; file transfers must never include
  // them. Explicit runtime/private roots retain their existing access rules.
  if (!runtimeRoots.includes(destination.root) && RESERVED_STATE_ROOTS.some(root =>
    destination.target === root || destination.target.startsWith(`${root}/`) || root.startsWith(`${destination.target}/`)))
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", "container file path overlaps a reserved root");
  return destination;
}
