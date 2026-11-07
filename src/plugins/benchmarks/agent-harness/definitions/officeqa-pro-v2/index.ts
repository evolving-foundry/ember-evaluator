import { LocalFileSource } from "../../../../../infrastructure/datasets/sources/local/files-source.js";
import { readRows } from "../../../../../infrastructure/datasets/input-readers/rows.js";
import { HuggingFaceSnapshotSource, type DatasetFileSource } from "../../../../../infrastructure/datasets/sources/huggingface/snapshot-source.js";
import { withDatasetActivity } from "../../../../../infrastructure/datasets/activity.js";
import { officeQAVerificationRuntime } from "./runtime/runtime.js";
import { expectNonEmptyString, expectRecord } from "../../../../../core/validation/input.js";
import { type EffectiveConfig } from "../../../../../core/contracts/config.js";
import type { Benchmark } from "../../../../../core/contracts/benchmark.js";
import type { PreparedTask, SourceLock, TaskRef } from "../../../../../core/contracts/task.js";
import type { ActivityListener } from "../../../../../core/contracts/activity.js";
import type { VerificationRuntime } from "../../../../../core/contracts/verification-runtime.js";
import { fingerprintConfig } from "../../../../../core/results/run-manifest.js";
import { planBenchmarkRun } from "../../../shared/plan-run.js";
import { buildOfficeQAProV2CorpusContext } from "./corpus.js";
import type { OfficeQAProV2Config } from "./config.js";

export { parseOfficeQAProV2Config } from "./config.js";
type Question = { uid: string; question: string; answer: string; source_docs: string; source_files: string };
type Loaded = { questions: Map<string, Question> };

/** Official questions and scorer with parsed JSON or original PDFs, not an image-only harness. */
export class OfficeQAProV2Benchmark implements Benchmark {
  readonly validateSourceOnCompletedResume = true;
  readonly verificationRuntime: VerificationRuntime;
  private readonly source: DatasetFileSource;
  private readonly loaded = new Map<string, Promise<Loaded>>();
  private readonly builds = new Map<string, Promise<NonNullable<PreparedTask["solveEnv"]["build"]>>>();
  private readonly prefix: string;
  private readonly suffix: string;

  constructor(readonly config: OfficeQAProV2Config, source?: DatasetFileSource,
    private readonly expected = { questions: 90, documents: 1435 }, network?: import("../../../../../core/contracts/network.js").NetworkAccess) {
    this.prefix = config.corpusFormat === "pdf" ? "pdfs/" : "parsed_corpus/jsons/";
    this.suffix = config.corpusFormat === "pdf" ? ".pdf" : ".json";
    const definition = { dataset: "databricks/officeqa-pro-v2", revision: config.revision,
      selections: [{ path: "officeqa_pro_v2.csv" }, { prefix: this.prefix, suffix: this.suffix }] };
    // Ray strips explicit credentials; execution nodes use their own HF_TOKEN.
    this.source = source ?? (config.localPath === undefined
      ? new HuggingFaceSnapshotSource(config.cacheDir, definition, config.hfToken ?? process.env.HF_TOKEN, undefined, network)
      : new LocalFileSource(config.localPath, definition));
    this.verificationRuntime = officeQAVerificationRuntime(config.dockerExecutable, network);
  }

  validateRun(config: EffectiveConfig): void {
    if (config.environment.name !== "docker") throw new TypeError("OfficeQA Pro V2 requires the Docker environment");
    if (config.verifier) throw new TypeError("OfficeQA Pro V2 uses its private official scorer; remove verifier");
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal, activity?: ActivityListener): Promise<SourceLock> {
    const lock = await withDatasetActivity(activity, () => this.source.resolve(previous, signal));
    const documents = lock.files.filter(file => file.path.startsWith(this.prefix) && file.path.endsWith(this.suffix));
    if (documents.length !== this.expected.documents || lock.files.length !== this.expected.documents + 1 ||
      !lock.files.some(file => file.path === "officeqa_pro_v2.csv")) throw new Error("OfficeQA Pro V2 corpus file count differs from expected release");
    this.loaded.clear();
    this.builds.clear();
    return lock;
  }

  private async load(lock: SourceLock, signal: AbortSignal): Promise<Loaded> {
    signal.throwIfAborted();
    const key = fingerprintConfig(lock);
    const existing = this.loaded.get(key);
    if (existing) return existing;
    const pending = this.loadUncached(lock, signal);
    this.loaded.set(key, pending);
    try { return await pending; }
    catch (error) { if (this.loaded.get(key) === pending) this.loaded.delete(key); throw error; }
  }

  private async loadUncached(lock: SourceLock, signal: AbortSignal): Promise<Loaded> {
    const questions = new Map<string, Question>();
    for await (const value of readRows(await this.source.file(lock, "officeqa_pro_v2.csv", signal), "csv")) {
      signal.throwIfAborted();
      const row = expectRecord(value, "OfficeQA question");
      const uid = expectNonEmptyString(row.uid, "OfficeQA uid");
      if (!/^[A-Za-z0-9_-]+$/u.test(uid) || questions.has(uid)) throw new Error(`Invalid or duplicate OfficeQA uid: ${uid}`);
      questions.set(uid, { uid, question: expectNonEmptyString(row.question, `OfficeQA ${uid} question`),
        answer: expectNonEmptyString(row.answer, `OfficeQA ${uid} answer`),
        source_docs: expectNonEmptyString(row.source_docs, `OfficeQA ${uid} source_docs`),
        source_files: expectNonEmptyString(row.source_files, `OfficeQA ${uid} source_files`) });
    }
    if (questions.size !== this.expected.questions) throw new Error("OfficeQA Pro V2 question count differs from expected release");
    return { questions };
  }

  async *enumerate(lock: SourceLock, signal: AbortSignal, activity?: ActivityListener): AsyncIterable<TaskRef> {
    const { questions } = await withDatasetActivity(activity, () => this.load(lock, signal));
    for (const uid of questions.keys()) { signal.throwIfAborted(); yield { id: uid, recordKey: uid }; }
  }

  async prepare(ref: TaskRef, lock: SourceLock, signal: AbortSignal, activity?: ActivityListener): Promise<PreparedTask> {
    if (ref.id !== ref.recordKey) throw new TypeError("Invalid OfficeQA task reference");
    const { questions } = await withDatasetActivity(activity, () => this.load(lock, signal));
    const row = questions.get(ref.id);
    if (!row) throw new Error(`Unknown OfficeQA task: ${ref.id}`);
    const key = fingerprintConfig(lock);
    let building = this.builds.get(key);
    if (!building) {
      building = withDatasetActivity(activity, () => buildOfficeQAProV2CorpusContext(this.source, lock, this.config.cacheDir, this.prefix, signal));
      this.builds.set(key, building);
    }
    let build: NonNullable<PreparedTask["solveEnv"]["build"]>;
    try { build = await building; }
    catch (error) { if (this.builds.get(key) === building) this.builds.delete(key); throw error; }
    return {
      input: { id: row.uid, prompt: `Answer the following question using the complete document corpus in /corpus (${this.config.corpusFormat}). You may search the corpus, run code, and obtain supplemental public information when necessary. Do not retrieve benchmark questions or reference answers online.\n\n${row.question}\n\nReturn a concise final answer on one line inside <FINAL_ANSWER>...</FINAL_ANSWER>. Put any explanation outside these tags.` },
      verification: { answer: row.answer, source_docs: row.source_docs, source_files: row.source_files,
        tolerance: this.config.tolerance, corpusFormat: this.config.corpusFormat },
      solveEnv: { workdir: "/workspace", image: null, initialFiles: [], runtime: [], build, network: "bridge" },
      verifyEnv: null, transfer: null,
      artifactCollection: { kind: "artifacts", workdir: "/workspace", paths: ["/workspace"] },
      preparationTimeoutSeconds: { solve: 3600, verify: 3600 },
    };
  }

  readonly planRun: NonNullable<Benchmark["planRun"]> = (refs, lock, signal, activity) =>
    planBenchmarkRun(this, refs, lock, signal, { version: "officeqa-pro-v2-preparation-v2", source: "officeqa-pro-v2 profile" }, 3600, activity);

  discloseAnswer(task: PreparedTask): string { return expectNonEmptyString(expectRecord(task.verification, "OfficeQA verification").answer, "OfficeQA answer"); }

  async verify(): Promise<never> { throw new Error("OfficeQA Pro V2 must be verified through its runtime lifecycle"); }
}
