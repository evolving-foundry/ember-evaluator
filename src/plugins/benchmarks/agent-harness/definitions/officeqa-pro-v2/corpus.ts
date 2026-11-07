import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import type { DatasetFileSource } from "../../../../../infrastructure/datasets/sources/huggingface/snapshot-source.js";
import type { SourceLock } from "../../../../../core/contracts/task.js";
import type { EnvironmentSpec } from "../../../../../core/contracts/environment.js";
import { buildFileManifest } from "../../../../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../../../../core/results/run-manifest.js";
import { PINNED_NODE_IMAGE } from "../../../../../infrastructure/containers/runtime-contract.js";
import { datasetActivity } from "../../../../../infrastructure/datasets/activity.js";

/** Build a context containing one official document representation, without rasterizing PDFs. */
export async function buildOfficeQAProV2CorpusContext(source: DatasetFileSource, lock: SourceLock, cacheDir: string,
  prefix: string, signal: AbortSignal): Promise<NonNullable<EnvironmentSpec["build"]>> {
  const files = lock.files.filter(file => file.path.startsWith(prefix));
  // The build context is constructed from this allowlist, never from the dataset root.
  const recipe = `FROM ${PINNED_NODE_IMAGE}\nRUN apt-get update && apt-get install -y --no-install-recommends python3 ripgrep poppler-utils && rm -rf /var/lib/apt/lists/*\nCOPY corpus/ /corpus/\nRUN chmod -R a-w /corpus && mkdir -p /workspace\nWORKDIR /workspace\n`;
  const identity = fingerprintConfig({ recipe, files: files.map(({ path, sha256 }) => ({ path, sha256 })) });
  const parent = join(cacheDir, "corpus-builds");
  const context = join(parent, identity);
  const names = files.map(file => basename(file.path));
  if (!files.length || new Set(names).size !== files.length || files.some(file => file.path.slice(prefix.length).includes("/")))
    throw new Error("Invalid OfficeQA corpus paths");
  await mkdir(parent, { recursive: true });
  const expected = new Map(files.map(file => [`corpus/${basename(file.path)}`, file.sha256]));
  const validate = async (root: string) => {
    const manifest = await buildFileManifest(root, []);
    signal.throwIfAborted();
    if (manifest.missing.length || manifest.files.length !== expected.size + 1 ||
      manifest.files.some(file => file.path !== "Dockerfile" && expected.get(file.path) !== file.sha256) ||
      await readFile(join(root, "Dockerfile"), "utf8") !== recipe)
      throw new Error("Cached OfficeQA public build context differs from locked corpus");
    return fingerprintConfig(manifest.files);
  };
  const existing = await lstat(context).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) return { context, dockerfile: "Dockerfile", sourceHash: await validate(context), visibility: "public" };
  return build();

  async function build(): Promise<NonNullable<EnvironmentSpec["build"]>> {
    const stage = await mkdtemp(join(parent, ".stage-"));
    try {
      await mkdir(join(stage, "corpus"));
      await writeFile(join(stage, "Dockerfile"), recipe, "utf8");
      for (const [index, file] of files.entries()) {
        signal.throwIfAborted();
        datasetActivity(`Preparing public document ${index + 1}/${files.length}`);
        await copyFile(await source.file(lock, file.path, signal), join(stage, "corpus", basename(file.path)));
      }
      await validate(stage);
      try { await rename(stage, context); }
      catch (cause) { signal.throwIfAborted(); await validate(context).catch(error => { throw new Error("OfficeQA build context publication failed", { cause: new AggregateError([cause, error]) }); }); }
      return { context, dockerfile: "Dockerfile", sourceHash: await validate(context), visibility: "public" };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
