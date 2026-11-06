import { evidencePath } from "../../../../../core/artifacts/artifacts.js";

export const HARBOR_REGISTRY_REVISION = "b83e7686999a18ba90a8603794d7d18d42cab010";
export const HARBOR_REGISTRY_URL = `https://raw.githubusercontent.com/harbor-framework/harbor/${HARBOR_REGISTRY_REVISION}/registry.json`;
export type HarborRegistryTask = { name: string; repository: string; commit: string; path: string };
const commitPattern = /^[a-f0-9]{40}$/;

export function parseHarborRegistry(value: unknown, dataset: string): HarborRegistryTask[] {
  const split = dataset.lastIndexOf("@");
  if (split < 1 || split === dataset.length - 1) throw new TypeError("Harbor dataset must be name@version");
  if (!Array.isArray(value)) throw new TypeError("Harbor registry must be an array");
  const entries = value.filter(
    row => row && row.name === dataset.slice(0, split) && String(row.version) === dataset.slice(split + 1),
  );
  if (entries.length !== 1 || !Array.isArray(entries[0].tasks) || !entries[0].tasks.length)
    throw new Error(`Dataset not uniquely defined in Harbor registry: ${dataset}`);
  const names = new Set<string>();
  const tasks = entries[0].tasks.map((task: unknown): HarborRegistryTask => {
    if (!task || typeof task !== "object") throw new TypeError("Invalid Harbor registry task");
    const row = task as Record<string, unknown>;
    if (
      typeof row.name !== "string" ||
      !row.name.trim() ||
      names.has(row.name) ||
      typeof row.git_commit_id !== "string" ||
      !commitPattern.test(row.git_commit_id) ||
      typeof row.path !== "string" ||
      typeof row.git_url !== "string"
    )
      throw new TypeError("Invalid or duplicate Harbor registry task identity");
    const url = new URL(row.git_url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new TypeError("Harbor v1 requires HTTPS GitHub task repositories");
    const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new TypeError("Invalid GitHub task repository");
    names.add(row.name);
    return { name: row.name, repository, commit: row.git_commit_id, path: evidencePath(row.path) };
  });
  return tasks.sort((a: HarborRegistryTask, b: HarborRegistryTask) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.name < b.name ? -1 : 1;
  });
}
