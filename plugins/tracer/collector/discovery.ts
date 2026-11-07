/** Locate result directories under the repository results root. */
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESULT_FILES = ["agentx-summary.json", "trajectory.jsonl"] as const;
const MAX_SCAN_DEPTH = 4;
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__"]);

const PACKAGE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function subdirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Browse roots for result directories: cwd/results first, then package/results. */
export function dirRoots(): string[] {
  const roots: string[] = [];
  for (const candidate of [resolve(process.cwd(), "results"), resolve(PACKAGE_ROOT, "results")]) {
    if (!roots.includes(candidate) && isDirectory(candidate)) roots.push(candidate);
  }
  return roots;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a directory holds importable artifacts, checked on fixed patterns only. */
export function hasResults(path: string): boolean {
  if (RESULT_FILES.some(name => isFile(join(path, name)))) return true;
  for (const task of subdirs(join(path, "tasks"))) {
    if (hasAgentArtifacts(join(path, "tasks", task))) return true;
  }
  for (const run of subdirs(path)) {
    for (const task of subdirs(join(path, run, "tasks"))) {
      if (hasAgentArtifacts(join(path, run, "tasks", task))) return true;
    }
  }
  return false;
}

function hasAgentArtifacts(taskDir: string): boolean {
  for (const attempt of subdirs(join(taskDir, "attempts"))) {
    const agent = join(taskDir, "attempts", attempt, "agent");
    if (RESULT_FILES.some(name => isFile(join(agent, name)))) return true;
  }
  return false;
}

/**
 * Resolve a run directory by name under the results root.
 *
 * Browsers only expose the picked folder's name, so the server searches its own
 * roots. When several directories share the name, prefer one holding artifacts,
 * then the newest.
 */
export function findDirByName(name: string): string | null {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return null;
  let best: { withResults: boolean; mtime: number; path: string } | null = null;
  for (const root of dirRoots()) {
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_SCAN_DEPTH) return;
      if (dir.split(/[\\/]/).pop() === name) {
        const withResults = hasResults(dir);
        const mtime = statSync(dir).mtimeMs;
        if (best === null || (withResults && !best.withResults) || (withResults === best.withResults && mtime > best.mtime)) {
          best = { withResults, mtime, path: dir };
        }
        return;
      }
      for (const child of subdirs(dir)) {
        if (child.startsWith(".") || SKIPPED_DIRS.has(child)) continue;
        walk(join(dir, child), depth + 1);
      }
    };
    walk(root, 0);
  }
  return best === null ? null : (best as { path: string }).path;
}
