import type { ErrorCode } from "../../../../../core/errors/registry.js";
import { posix } from "node:path";
import { RESERVED_STATE_ROOTS } from "../../../../../infrastructure/filesystem/workspace-transfer.js";

export type HarborStateProfile = { workdir: string; extraPaths: string[] };
export class HarborTaskError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HarborTaskError";
  }
}

export function validateStateProfile(profile: HarborStateProfile): void {
  const roots = [profile.workdir, ...profile.extraPaths];
  const reserved = RESERVED_STATE_ROOTS;
  for (const path of roots) {
    if (
      !path.startsWith("/") ||
      path === "/" ||
      path.includes("\\") ||
      path.includes("\0") ||
      posix.normalize(path) !== path ||
      reserved.some(root => path === root || path.startsWith(root + "/") || root.startsWith(path + "/"))
    ) {
      throw new HarborTaskError("TRANSFER_UNSAFE", `Unsafe state transfer root: ${path}`);
    }
  }
  for (let index = 0; index < roots.length; index++)
    for (const other of roots.slice(index + 1)) {
      if (other === roots[index] || other.startsWith(roots[index]! + "/") || roots[index]!.startsWith(other + "/")) {
        throw new HarborTaskError("TRANSFER_UNSAFE", "State transfer roots overlap");
      }
    }
}
