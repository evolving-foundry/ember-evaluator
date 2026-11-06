import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { insertDockerfileStageSettings } from "./dockerfile.js";

const filename = ".evaluator-pip-constraints.txt";
const containerPath = "/opt/evaluator-build/pip-constraints.txt";
const version = "(?:===|==|~=|!=|<=|>=|<|>)\\s*[A-Za-z0-9*][A-Za-z0-9.*+!_-]*";
const requirement = new RegExp(`^([A-Za-z0-9][A-Za-z0-9._-]*)\\s*${version}(?:\\s*,\\s*${version})*$`, "u");

function parseConstraints(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("docker buildPipConstraints values must be arrays of package version constraints");
  const packages = new Set<string>();
  return value.map(item => {
    if (typeof item !== "string" || /[\r\n\0]/u.test(item)) throw new TypeError("Invalid docker buildPipConstraints entry");
    const match = requirement.exec(item.trim());
    if (!match) throw new TypeError("docker buildPipConstraints requires package names and version bounds, without URLs, options or markers");
    const name = match[1]!.toLowerCase().replace(/[-_.]+/gu, "-");
    if (packages.has(name)) throw new TypeError(`Duplicate package in docker buildPipConstraints: ${name}`);
    packages.add(name);
    return item.trim();
  });
}

export function parseBuildPipConstraints(value: unknown = {}): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("docker buildPipConstraints must map task IDs (or *) to package version constraints");
  return Object.fromEntries(Object.entries(value).map(([taskId, constraints]) => {
    if (!taskId.trim() || /[\r\n\0]/u.test(taskId)) throw new TypeError("Invalid task ID in docker buildPipConstraints");
    return [taskId, parseConstraints(constraints)];
  }));
}

/** Mutate only the admitted private build snapshot, never the dataset context. */
export async function applyBuildPipConstraints(context: string, dockerfile: string, constraints: readonly string[], signal: AbortSignal): Promise<void> {
  if (!constraints.length) return;
  signal.throwIfAborted();
  const recipe = await readFile(dockerfile, { encoding: "utf8", signal });
  const constrained = insertDockerfileStageSettings(recipe, [
    `COPY --chmod=0644 ${JSON.stringify([filename, containerPath])}`,
    `ENV PIP_CONSTRAINT=${containerPath}`,
  ]);
  if (recipe === constrained) throw new Error("Cannot apply buildPipConstraints: Dockerfile has no FROM instruction");
  await writeFile(join(context, filename), constraints.join("\n") + "\n", { flag: "wx", signal });
  const specific = dockerfile + ".dockerignore";
  const hasSpecific = await lstat(specific).then(() => true, error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
  const ignoreFile = hasSpecific ? specific : join(context, ".dockerignore");
  const ignore = await readFile(ignoreFile, "utf8").catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  await writeFile(ignoreFile, ignore + `\n!/${filename}\n`, { signal });
  await writeFile(dockerfile, constrained, { signal });
}
