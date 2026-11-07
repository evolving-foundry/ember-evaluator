/** Deterministic analysis, LLM analysis orchestration and on-disk export. */
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { attachParentPerf, buildFeedback, isProfilingRun, population, profilingPerf } from "./aggregate.js";
import { buildConclusion, conclusionMarkdown } from "./conclusion.js";
import { computeDelta, findParent } from "./delta.js";
import { findDirByName } from "./discovery.js";
import { type Lang, msg, scopeOf } from "./i18n.js";
import { analyzeEpoch } from "./llm-analysis.js";
import { RT } from "./runtime.js";
import { buildSignals } from "./signals.js";

// Epochs with an analysis in flight; keeps refreshes from stacking duplicate runs.
const ANALYZING = new Set<string>();
// Epochs whose automatic analysis failed once; manual rerun is required.
const ANALYSIS_FAILED = new Set<string>();

type Obj = Record<string, unknown>;

interface ConclusionOptions {
  run?: Obj | null;
  traces?: Obj[] | null;
  outcomes?: Obj[] | null;
  population?: Obj | null;
  signals?: Obj[] | null;
  delta?: Obj | null;
  analysis?: Obj | null;
  lang?: Lang;
}

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function listOf(value: unknown): Obj[] {
  return Array.isArray(value) ? (value as Obj[]) : [];
}

function generatedAt(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function analyzing(epoch: string): boolean {
  return ANALYZING.has(epoch);
}

export function markAnalyzing(epoch: string): void {
  ANALYZING.add(epoch);
}

export function release(epoch: string): void {
  ANALYZING.delete(epoch);
}

export function failed(epoch: string): boolean {
  return ANALYSIS_FAILED.has(epoch);
}

export function markFailed(epoch: string): void {
  ANALYSIS_FAILED.add(epoch);
}

export function clearFailed(epoch: string): void {
  ANALYSIS_FAILED.delete(epoch);
}

/** Background analysis; failures must never affect the finish response. */
export async function analyzeEpochTask(epoch: string, lang: Lang = "en"): Promise<Obj | null> {
  if (RT.store === null) return null;
  let result: Obj | null;
  try {
    result = await analyzeEpoch(RT.db, epoch, false, lang);
  } catch (error) {
    RT.st.metrics.processing_errors += 1;
    console.error(`[tracer] llm analysis crashed for ${epoch}: ${String(error)}`);
    return null;
  }
  if (result && result.error) {
    console.error(`[tracer] llm analysis failed for ${epoch}: ${String(result.error)}`);
  } else if (result) {
    // The plugin exports at finish time, before the LLM result exists.
    exportAnalysis(epoch, null, lang);
  }
  return result;
}

export async function reanalyze(epoch: string, lang: Lang = "en"): Promise<void> {
  try {
    const result = await analyzeEpochTask(epoch, lang);
    if (result === null || result.error) ANALYSIS_FAILED.add(epoch);
  } finally {
    ANALYZING.delete(epoch);
  }
}

/** runs.artifacts holds JSON text; corrupted values must not break the API. */
export function artifactsOf(run: Obj | null): Obj {
  const raw = asObject(run).artifacts;
  if (!raw) return {};
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve <run>/analysis: the recorded run_dir first, otherwise by directory name. */
export function runAnalysisDir(epoch: string): string | null {
  const runDir = artifactsOf(RT.db.getRun(epoch)).run_dir;
  let root = typeof runDir === "string" && runDir ? runDir : null;
  if (root === null || !isDirectory(root)) root = findDirByName(epoch);
  return root === null ? null : join(root, "analysis");
}

/**
 * Write the contract artifacts into <run>/analysis. feedback.json is the
 * self-contained OptFeedback document: the LLM analysis and the deterministic
 * conclusion are embedded instead of being duplicated in separate files.
 */
export function exportAnalysis(epoch: string, runDir: string | null = null, lang: Lang = "en"): void {
  try {
    const out = runDir ? join(runDir, "analysis") : runAnalysisDir(epoch);
    if (out === null) return;
    // Chinese is a translation of the canonical English artifacts; keep the two sets apart so
    // viewing one language never overwrites the other on disk.
    const target = lang === "zh" ? join(out, "zh") : out;
    mkdirSync(target, { recursive: true });
    const conclusion = conclusionOf(epoch, { lang });
    const signals = signalsPayload(epoch, lang);
    const run = RT.db.getRun(epoch) ?? {};
    const feedback = buildFeedback(epoch, run, RT.db.listTraces(epoch), RT.db.listOutcomes(epoch), RT.db, lang);
    feedback.analysis = asObject(conclusion.analysis);
    feedback.conclusion = conclusion;
    const files: Record<string, string> = {
      "signals.json": JSON.stringify(signals, null, 2),
      "signals.md": signalsMarkdown(signals, lang),
      "conclusion.json": JSON.stringify(conclusion, null, 2),
      "conclusion.md": conclusionMarkdown(conclusion, lang),
      "feedback.json": JSON.stringify(feedback, null, 2),
    };
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(target, name), text, "utf8");
    }
    // Older exports wrote a standalone copy; drop it so the directory matches the current contract.
    rmSync(join(target, "analysis.json"), { force: true });
  } catch (error) {
    console.error(`[tracer] export analysis failed for ${epoch}: ${String(error)}`);
  }
}

/** Deterministic signals: rule-based only, safe for downstream consumers. */
export function signalsPayload(epoch: string, lang: Lang = "en"): Obj {
  const run = RT.db.getRun(epoch) ?? {};
  const traces = RT.db.listTraces(epoch);
  const outcomes = RT.db.listOutcomes(epoch);
  const pop = population(traces, outcomes);
  const payload: Obj = {
    schema_version: 1,
    epoch,
    status: run.status,
    generated_at: generatedAt(),
    source: "rules",
    population: pop,
    signals: buildSignals(traces, outcomes, pop, lang),
  };
  // Profiling runs carry per-tier inference/hardware metrics instead of population data.
  if (isProfilingRun(traces)) {
    const perf = profilingPerf(traces, lang);
    const parent = attachParentPerf(perf, epoch, run, RT.db, lang);
    if (parent) perf.parent = parent;
    payload.profiling = perf;
  }
  return payload;
}

export function signalsMarkdown(payload: Obj, lang: Lang = "en"): string {
  const lines: string[] = [
    msg(lang, `# Deterministic signals · epoch ${String(payload.epoch)}`, `# 确定性信号 · epoch ${String(payload.epoch)}`),
    "",
    `- status: ${String(payload.status ?? "—")}`,
    `- generated_at: ${String(payload.generated_at)}`,
    msg(lang, "- source: rules (independent of the LLM, reproducible)", "- source: rules（不依赖 LLM，可重复计算）"),
    "",
  ];
  const pop = asObject(payload.population);
  if (Object.keys(pop).length > 0) {
    lines.push(msg(lang, "| Metric | Value |", "| 指标 | 值 |"), "| --- | --- |");
    for (const [key, value] of Object.entries(pop)) {
      if (typeof value === "number" || typeof value === "string" || value === null) {
        lines.push(`| ${key} | ${value === null ? "—" : String(value)} |`);
      }
    }
    lines.push("");
  }
  const signals = listOf(payload.signals);
  const counts: Record<string, number> = {};
  for (const signal of signals) {
    const severity = String(signal.severity ?? "low");
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  const summary = Object.entries(counts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ");
  lines.push(
    msg(
      lang,
      `## Summary: ${signals.length} signal(s) (${summary || "none"})`,
      `## 汇总：${signals.length} 条（${summary || "无"}）`,
    ),
  );
  lines.push("");
  for (const signal of signals) {
    const severity = String(signal.severity ?? "low");
    lines.push(`### [${severity.toUpperCase()}] ${String(signal.target ?? "")} / ${String(signal.category ?? "")}`);
    lines.push("");
    lines.push(String(signal.title ?? ""));
    if (signal.detail) {
      lines.push("");
      lines.push(String(signal.detail));
    }
    const suggestion = asObject(signal.suggestion).direction;
    if (suggestion) {
      lines.push("");
      lines.push(`→ ${String(suggestion)}`);
    }
    const evidence = signal.evidence;
    if (evidence) {
      lines.push("");
      lines.push(`evidence: \`${stableJson(evidence)}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** json.dumps(..., sort_keys=True) for evidence rendering. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Obj)
      .sort()
      .map(key => `${JSON.stringify(key)}: ${stableJson((value as Obj)[key])}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** Task-level delta only needs the parent's outcomes, not a full population pass. */
function parentContext(epoch: string, run: Obj | null): Obj | null {
  if (!run || !run.parent_id) return null;
  const [parentEpoch] = findParent(RT.db, epoch, run);
  if (!parentEpoch) return null;
  return { epoch: parentEpoch, outcomes: RT.db.listOutcomes(parentEpoch) };
}

/** Build the conclusion, reusing any intermediate results already computed. */
export function conclusionOf(epoch: string, options: ConclusionOptions = {}): Obj {
  const store = RT.db;
  const lang = options.lang ?? "en";
  const run = options.run ?? store.getRun(epoch) ?? {};
  const traces = options.traces ?? store.listTraces(epoch);
  const outcomes = options.outcomes ?? store.listOutcomes(epoch);
  const pop = options.population ?? population(traces, outcomes);
  const signals: Obj[] = options.signals ?? buildSignals(traces, outcomes, pop, lang);
  let delta = options.delta ?? null;
  if (delta === null && run.parent_id) {
    const [parentEpoch, parentRun] = findParent(store, epoch, run);
    if (parentEpoch) {
      const parentPop = population(store.listTraces(parentEpoch), store.listOutcomes(parentEpoch));
      delta = computeDelta(run, pop, parentRun, parentPop, parentEpoch, lang)[0];
    }
  }
  const analysis = options.analysis ?? (store.getLatestAnalysis(epoch, scopeOf("epoch", lang)) as Obj | null);
  return buildConclusion(epoch, run, pop, signals, outcomes, traces, delta, parentContext(epoch, run), analysis, lang);
}

export function conclusionPayload(epoch: string, format = "json", lang: Lang = "en"): Obj | string {
  const conclusion = conclusionOf(epoch, { lang });
  return format === "md" ? conclusionMarkdown(conclusion, lang) : conclusion;
}
