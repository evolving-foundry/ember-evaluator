import { evidencePath } from "../../../../core/artifacts/artifacts.js";

export type GitTreeEntry = { path: string; sha: string; type: string; mode: string };
const commitPattern = /^[a-f0-9]{40}$/;

export function parseGitTree(value: unknown): GitTreeEntry[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("tree" in value) ||
    !Array.isArray(value.tree) ||
    !("truncated" in value) ||
    value.truncated !== false
  )
    throw new TypeError("Invalid or truncated Git tree");
  const seen = new Set<string>();
  return value.tree.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new TypeError("Invalid Git tree entry");
    const row = item as Record<string, unknown>;
    if (
      typeof row.path !== "string" ||
      typeof row.sha !== "string" ||
      !commitPattern.test(row.sha) ||
      typeof row.mode !== "string" ||
      typeof row.type !== "string"
    )
      throw new TypeError("Invalid Git tree entry");
    const path = evidencePath(row.path);
    if (seen.has(path)) throw new TypeError("Duplicate Git tree path");
    seen.add(path);
    return { path, sha: row.sha, mode: row.mode, type: row.type };
  });
}
