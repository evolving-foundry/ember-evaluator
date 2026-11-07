/** Optional LLM feedback analysis; inactive without TRACER_LLM_BASE_URL and TRACER_LLM_MODEL. */
import { createHash } from "node:crypto";

import { isProfilingRun, population, profilingPerf } from "./aggregate.js";
import { type Lang, msg, scopeOf } from "./i18n.js";
import { round } from "./num.js";

const SEVERITIES = ["high", "medium", "low"] as const;
const MAX_FINDINGS = 12;
const MAX_ATTEMPTS = 50;
const MAX_FAILED_TASKS = 20;
const MAX_FIELD_CHARS = 200;

// The real performance measure for profiling. Tier index, duration and load do not count: only
// numeric values in these fields prove metrics were sampled, otherwise the summary is an empty shell.
const PROFILING_METRIC_KEYS = [
  "ttft_p50",
  "ttft_p95",
  "itl_mean",
  "latency_p95",
  "throughput",
  "interactivity",
  "cache_hit",
  "npu_util",
  "aicore_util",
  "hbm_usage",
  "temperature",
];

/** Process-wide counters exposed via /metrics to tell whether the LLM was called and how it failed. */
export const STATS = {
  calls: 0,
  cache_hits: 0,
  failures: 0,
  dropped: 0,
  last_error: null as string | null,
  translate_calls: 0,
  translate_cache_hits: 0,
  translate_failures: 0,
  last_translate_error: null as string | null,
};

type Obj = Record<string, unknown>;
type RefSet = Set<string>;

interface LlmConfig {
  base: string;
  model: string;
  key: string;
  timeout: number;
  max_tokens: number;
}

interface Refs {
  step_ids: RefSet;
  sessions: RefSet;
  metrics: RefSet;
}

interface StoreLike {
  listTraces(epoch: string, session?: string | null, limit?: number | null, offset?: number): Obj[];
  listOutcomes(epoch: string): Obj[];
  getAnalysis(epoch: string, digestHash: string, model: string, scope?: string): unknown;
  saveAnalysis(epoch: string, digestHash: string, model: string, payload: unknown, scope?: string): void;
  getOutcome(epoch: string, attemptId: string | null): Obj | null;
}

function trajPrompt(): string {
  return (
    "You diagnose ONE agent attempt from an LLM evaluation run. FACTS is a digest: " +
    "attempt id, totals, inference/cache/hardware metrics, and steps with " +
    "{step_id, fn, dur, status, error, msg}.\n" +
    "Rules:\n" +
    "1. Never invent step ids or metric names. Only reference values present in FACTS.\n" +
    '2. Put exactly one reference in evidence: {"step_id": ...} or {"metric": ...}.\n' +
    "3. Focus on the slowest steps, failed steps and any obviously wasteful pattern; " +
    "explain what to change in this attempt specifically.\n" +
    "4. Return at most 8 findings, ordered by how much each one affects task success " +
    "first, then by time/cost, and put the highest severity first. Keep title short " +
    "and detail/recommendation under 120 characters each; never paste commands, logs " +
    "or stack traces into the output.\n" +
    "5. Do not report missing telemetry as a problem; skip categories the data cannot " +
    "support. Keep JSON keys and identifiers (step_id, metric, category, severity, " +
    "function names) unchanged. Write every free-text field in English. " +
    "Respond with strict JSON, no prose, no code fences:\n" +
    '{"summary": "one sentence", "findings": [{"severity": "high|medium|low", ' +
    '"category": "bottleneck|error|quality|cost|cache|latency|efficiency", ' +
    '"title": "short", "detail": "evidence-based explanation", ' +
    '"evidence": {"step_id": "s3"}, "recommendation": "what to change"}]}'
  );
}

// Scenario blocks: shared rules live once in the base prompt, scenarios only fill in the differences.
// To add a scenario (e.g. operator-optimization RSI), add one entry plus a facts builder; the template stays put.
interface Scenario {
  role: string;
  focus: string;
  evidence: string;
  evidence_example: string;
  ordering: string;
  categories: string;
}

const SCENARIOS: Record<string, Scenario> = {
  run: {
    role:
      "an LLM agent evaluation run. You are given FACTS only: population metrics, " +
      "per-attempt step summaries, and failed tasks.",
    focus:
      "Focus on failed and slowest steps plus obviously wasteful patterns, and explain " +
      "what to change in this run specifically. Do not report missing telemetry as a " +
      "problem; skip categories the data cannot support (e.g. cache when " +
      "cache_observable is false).",
    evidence:
      '{"step_id": ...}, {"session": ...} or {"metric": ...}; omit evidence when ' + "nothing specific applies",
    evidence_example: '{"step_id": "s3"}',
    ordering: "by how much each one affects task success, then by time/cost",
    categories: "bottleneck|error|quality|cost|cache|latency|efficiency",
  },
  profiling: {
    role:
      "one inference profiling run (agentx workload) of an LLM deployment. FACTS holds " +
      "one row per concurrency tier: ttft_p50/ttft_p95/itl_mean/latency_p95 in ms, " +
      "throughput in tokens/s, interactivity in tokens/s/user, cache_hit as a 0..1 " +
      "ratio, npu_util/aicore_util/hbm_usage in %, temperature in °C, plus that tier's " +
      "requests, input/output tokens, duration_s and warmup_ttft_p95.",
    focus:
      "Every row is one concurrency level: compare rows to judge scaling (how " +
      "throughput grows versus how TTFT/ITL grow), name the affected tier, and give a " +
      "concrete tuning action (chunked prefill, max-num-seqs, max-model-len, prefix " +
      "caching, KV cache, tensor/data parallel, gpu-memory-utilization, scheduling). " +
      "This run has no agent steps by design: never ask for step/span telemetry, never " +
      "treat empty steps, tasks or population as an instrumentation bug, and never " +
      "discuss task success rate, reward or cost per task.",
    evidence: '{"metric": "<key from FACTS>"}',
    evidence_example: '{"metric": "ttft_p95"}',
    ordering: "by how much each one limits throughput or tail latency",
    categories: "bottleneck|latency|efficiency|cache|error",
  },
};

function renderPrompt(scenario: Scenario): string {
  return (
    `You diagnose ${scenario.role}\n` +
    "Rules:\n" +
    "1. Never invent numbers, ids, sessions or metric names. Only refer to values present in FACTS.\n" +
    `2. ${scenario.focus}\n` +
    `3. Put exactly one reference in evidence: ${scenario.evidence}.\n` +
    "4. If FACTS marks the data as missing (data_missing=true), state in summary that the metrics " +
    "are missing and return no findings instead of guessing.\n" +
    `5. Return at most 8 findings, highest severity first, ${scenario.ordering}. Keep title short and ` +
    "detail/recommendation under 120 characters each; never paste commands, logs or stack traces.\n" +
    "6. Keep JSON keys " +
    "and identifiers (step_id, session, metric, category, severity, function names) unchanged. " +
    "Write every free-text field in English. " +
    "Respond with strict JSON, no prose, no code fences:\n" +
    '{"summary": "one sentence", "findings": [{"severity": "high|medium|low", ' +
    `"category": "${scenario.categories}", "title": "short", ` +
    `"detail": "evidence-based explanation", "evidence": ${scenario.evidence_example}, ` +
    '"recommendation": "what to change"}]}'
  );
}

const PROMPTS: Record<string, string> = Object.fromEntries(
  Object.entries(SCENARIOS).map(([name, scenario]) => [name, renderPrompt(scenario)]),
);

/**
 * Translation prompt: the English analysis is the single source of truth and Chinese is derived
 * from it, so the toggle never changes what the model concluded, only the language it is written in.
 */
const TRANSLATE_PROMPT =
  "You are a translation engine. Translate the natural-language fields of the JSON below " +
  "into Simplified Chinese (简体中文).\n" +
  "Rules:\n" +
  "1. Translate only: summary, findings[].title, findings[].detail, findings[].recommendation.\n" +
  "2. Keep every identifier, step id, session id, metric name, function name, number, unit and " +
  "percentage unchanged.\n" +
  "3. Do not add, remove, merge or reorder findings; emit exactly one output item per input item.\n" +
  "4. Do not explain, do not add commentary, no code fences. Respond with strict JSON only:\n" +
  '{"summary": "...", "findings": [{"title": "...", "detail": "...", "recommendation": "..."}]}';

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function listOf(value: unknown): Obj[] {
  return Array.isArray(value) ? (value as Obj[]) : [];
}

/** Hash of the translatable text only; a new timestamp must not invalidate a cached translation. */
export function contentHash(payload: Obj): string {
  const findings = listOf(payload.findings).map(finding => ({
    title: finding.title,
    detail: finding.detail,
    recommendation: finding.recommendation,
  }));
  return createHash("sha256")
    .update(JSON.stringify(canonical({ summary: payload.summary, findings })), "utf8")
    .digest("hex");
}

/** Only natural-language fields travel to the translator; structure never leaves the host. */
function translationInput(payload: Obj): Obj {
  return {
    summary: String(payload.summary ?? ""),
    findings: listOf(payload.findings).map(finding => ({
      title: String(finding.title ?? ""),
      detail: String(finding.detail ?? ""),
      recommendation: String(finding.recommendation ?? ""),
    })),
  };
}

/** Re-attach translated text to the English structure; a shape mismatch discards the whole answer. */
function mergeTranslation(en: Obj, text: Obj): { payload: Obj; error: string | null } {
  const source = listOf(en.findings);
  const translated = listOf(text.findings);
  if (translated.length !== source.length) return { payload: en, error: "finding count mismatch" };
  const findings: Obj[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const item = asObject(translated[index]);
    const title = String(item.title ?? "").trim();
    const detail = String(item.detail ?? "").trim();
    const recommendation = String(item.recommendation ?? "").trim();
    if (!title || !detail || !recommendation) {
      return { payload: en, error: `finding ${index} has empty translated fields` };
    }
    findings.push({ ...source[index]!, title, detail, recommendation });
  }
  const summary = String(asObject(text).summary ?? "").trim();
  if (!summary) return { payload: en, error: "empty translated summary" };
  return { payload: { ...en, summary, findings }, error: null };
}

/**
 * Chinese is a translation of the English payload, never a second generation run: the caller gets
 * identical finding count, order, severity, category and evidence, only the text differs.
 */
async function ensureTranslation(
  store: StoreLike,
  cacheId: string,
  digest: string,
  en: Obj,
  scope: string,
  force = false,
): Promise<Obj> {
  const cfg = config();
  if (cfg === null || en.source !== "llm") return { ...en, lang: "zh" };
  const want = contentHash(en);
  if (!force) {
    const cached = store.getAnalysis(cacheId, digest, cfg.model, scope) as Obj | null;
    if (cached !== null && cached.translated_from === want) {
      STATS.translate_cache_hits += 1;
      return cached;
    }
  }
  STATS.translate_calls += 1;
  try {
    const raw = await call(cfg, translationInput(en), TRANSLATE_PROMPT);
    const merged = mergeTranslation(en, asObject(parse(raw)));
    if (merged.error !== null) throw new Error(merged.error);
    const payload: Obj = {
      ...merged.payload,
      lang: "zh",
      translated: true,
      translated_from: want,
      translation_model: cfg.model,
      generated_at: Date.now() / 1000,
    };
    store.saveAnalysis(cacheId, digest, cfg.model, payload, scope);
    return payload;
  } catch (error) {
    STATS.translate_failures += 1;
    STATS.last_translate_error = String(error);
    // Keep the English text: falling back to the rule layer here would break the parity guarantee.
    return { ...en, lang: "zh", translated: false, translation_error: String(error) };
  }
}

function numericEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Read provider config; returns null when required settings are missing (rules-only mode).
 *
 * TRACER_LLM_* is the collector-specific override and takes precedence; when absent it falls
 * back to the evaluation side's MODEL_NAME / MODEL_ENDPOINT / MODEL_API_KEY. Those are usually
 * always present, so making them win would disable the override entirely.
 */
export function config(): LlmConfig | null {
  const base = (process.env.TRACER_LLM_BASE_URL ?? process.env.MODEL_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const model = (process.env.TRACER_LLM_MODEL ?? process.env.MODEL_NAME ?? "").trim();
  if (!base || !model) return null;
  return {
    base,
    model,
    key: (process.env.TRACER_LLM_API_KEY ?? process.env.MODEL_API_KEY ?? "").trim(),
    // Reasoning models think before answering; 30-90s per call is common, so 30s would time out.
    timeout: numericEnv("TRACER_LLM_TIMEOUT") ?? 120.0,
    // Reasoning models spend reasoning_tokens first, and 3000 is often eaten entirely, leaving an
    // empty body; default to a generous 8000 and override with TRACER_LLM_MAX_TOKENS to save quota.
    max_tokens: Math.trunc(numericEnv("TRACER_LLM_MAX_TOKENS") ?? 8000),
  };
}

/** For stable serialization: sort dict keys and fix float precision so the same facts hash the same. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Obj;
    const out: Obj = {};
    for (const key of Object.keys(record).sort()) out[key] = canonical(record[key]);
    return out;
  }
  if (typeof value === "number" && !Number.isInteger(value)) return round(value, 4);
  return value;
}

export function digestHash(facts: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(facts)), "utf8").digest("hex");
}

function clip(value: unknown, limit = MAX_FIELD_CHARS): unknown {
  if (typeof value === "string" && value.length > limit) return `${value.slice(0, limit)}…`;
  return value;
}

/** Truncate long strings in the digest while keeping structure and step_id so evidence still validates. */
function shrinkDigest(digest: Obj): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(digest)) {
    if (key !== "steps") out[key] = clip(value);
  }
  out.steps = listOf(digest.steps)
    .filter(step => step !== null && typeof step === "object")
    .map(step => Object.fromEntries(Object.entries(step).map(([key, value]) => [key, clip(value)])));
  return out;
}

/**
 * Facts for a profiling run: inference/hardware metrics and load per concurrency tier.
 *
 * agentx profiling trajectories only carry lifecycle events (steps are always empty) and the population
 * is entirely empty too; handing that to the model only yields the wrong conclusion that instrumentation
 * is broken, so supply data that really explains performance and state that empty steps are by design.
 */
function profilingFacts(traces: Obj[]): [Obj, Refs] {
  const perf = profilingPerf(traces);
  const tiers = listOf(perf.tiers);
  // Align load fields by (concurrency tier, source session): when one tier has several summaries,
  // keying by tier alone lets the later one overwrite the earlier and mixes A's requests into B's metrics.
  const extras = new Map<string, Obj>();
  for (const trace of traces) {
    if (trace.kind !== "summary") continue;
    const payload = asObject(trace.payload);
    const workload = asObject(payload.workload);
    const profiling = asObject(payload.profiling ?? payload.profiling_metrics);
    const concurrency = workload.concurrency;
    const key = `${Number.isInteger(concurrency) ? String(concurrency) : "null"}|${String(trace.session ?? "")}`;
    const warmup = asObject(payload.warmup).ttft;
    extras.set(key, {
      warmup_ttft_p95: warmup !== null && typeof warmup === "object" ? asObject(warmup).p95 : null,
      variant: workload.variant,
      duration_s: workload.durationSeconds,
      requests: asObject(profiling.requests).mean,
      input_tokens: asObject(profiling.inputTokens).mean,
      output_tokens: asObject(profiling.outputTokens).mean,
    });
  }
  const rows: Obj[] = [];
  for (const row of tiers) {
    const tier: Obj = { ...row };
    const key = `${String(row.concurrency)}|${String(row.session ?? "")}`;
    let extra = extras.get(key);
    if (extra === undefined) {
      // Fallback: when summaries do not line up with tier rows, take the first by tier; better under-aligned than dropped.
      extra = {};
      for (const [candidateKey, candidate] of extras) {
        if (candidateKey.split("|")[0] === String(row.concurrency)) {
          extra = candidate;
          break;
        }
      }
    }
    for (const [name, value] of Object.entries(extra)) {
      if (value !== null && value !== undefined) tier[name] = value;
    }
    rows.push(tier);
  }
  const facts: Obj = {
    mode: "profiling",
    tiers: rows,
    cache_observable: rows.some(tier => tier.cache_hit !== null && tier.cache_hit !== undefined),
  };
  // Mark data as missing when only the summary shell exists (no profiling numbers, no telemetry),
  // so the model states "metrics missing" instead of inventing tuning advice from tier numbers.
  if (!rows.some(tier => PROFILING_METRIC_KEYS.some(key => isNumber(tier[key])))) {
    facts.data_missing = true;
  }
  const refs: Refs = {
    step_ids: new Set(),
    sessions: new Set(rows.filter(tier => tier.session).map(tier => String(tier.session))),
    // Evidence only accepts numeric metric keys, so descriptive fields like variant cannot be cited as a metric.
    metrics: new Set(rows.flatMap(tier => Object.entries(tier).filter(([, value]) => isNumber(value)).map(([key]) => key))),
  };
  return [facts, refs];
}

/** Facts for a normal agent run: population, per-attempt step summary and failed tasks. */
function runFacts(traces: Obj[], outcomes: Obj[]): [Obj, Refs] {
  const pop = population(traces, outcomes);
  const attempts: Obj[] = [];
  const stepIds = new Set<string>();
  const sessions = new Set<string>();
  let cacheObserved = false;
  for (const trace of traces) {
    if (String(trace.kind ?? "") !== "trajectory") continue;
    const payload = asObject(trace.payload);
    const steps = listOf(payload.steps);
    const session = String(trace.session ?? payload.session_id ?? "");
    sessions.add(session);
    const rows: Obj[] = [];
    for (const step of steps) {
      if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
      const stepId = String(step.step_id ?? "");
      if (stepId) stepIds.add(stepId);
      const extra = asObject(step.extra);
      const invocation = asObject(extra.invocation);
      const ancestry = asObject(extra.ancestry);
      const metrics = asObject(step.metrics);
      const start = invocation.start_timestamp;
      const end = invocation.end_timestamp;
      const duration = isNumber(start) && isNumber(end) ? round(end - start, 3) : null;
      rows.push({
        step_id: stepId,
        fn: ancestry.function_name ?? step.source ?? "",
        source: step.source,
        duration_s: duration,
        status: invocation.status,
        prompt_tokens: metrics.prompt_tokens,
        completion_tokens: metrics.completion_tokens,
        cached_tokens: metrics.cached_tokens,
      });
      if (isNumber(metrics.cached_tokens)) cacheObserved = true;
    }
    const timed = rows.filter(row => row.duration_s !== null && row.duration_s !== undefined);
    attempts.push({
      session,
      steps: steps.length,
      slowest: timed.sort((a, b) => Number(b.duration_s) - Number(a.duration_s)).slice(0, 5),
      errors: rows
        .filter(row => !["", "ok", "success"].includes(String(row.status ?? "").toLowerCase()))
        .slice(0, 10),
    });
  }
  const failed = outcomes
    .filter(outcome => !outcome.success)
    .slice(0, MAX_FAILED_TASKS)
    .map(outcome => ({
      task_id: outcome.task_id,
      reward: outcome.reward,
      latency_ms: outcome.latency_ms,
      status: outcome.status,
      // The answer and method extracted by the grader, to tell "model answered wrong" from "grader missed it".
      verification: outcome.verdict_details,
    }));
  const facts: Obj = {
    population: pop,
    tasks: outcomes.length,
    failed_tasks: failed,
    cache_observable: cacheObserved,
    attempts: attempts.slice(0, MAX_ATTEMPTS),
  };
  const refs: Refs = {
    step_ids: stepIds,
    sessions,
    metrics: new Set([
      ...Object.keys(pop),
      "success_rate",
      "steps_mean",
      "p50_latency_ms",
      "p95_latency_ms",
      "cost_usd",
      "cost_per_task",
    ]),
  };
  return [facts, refs];
}

function modeOf(traces: Obj[]): string {
  return isProfilingRun(traces) ? "profiling" : "run";
}

/** Compress traces into deterministic facts and return the reference sets used to validate evidence. */
export function buildFacts(traces: Obj[], outcomes: Obj[]): [Obj, Refs] {
  return modeOf(traces) === "profiling" ? profilingFacts(traces) : runFacts(traces, outcomes);
}

/** Scenario -> prompt. Scenario differences live in SCENARIOS; the template itself is shared. */
function promptFor(facts: Obj | null): string {
  const key = String(facts?.mode ?? "run");
  return PROMPTS[key] ?? PROMPTS.run!;
}

/** Whether finish still needs an LLM analysis: English generated, plus a fresh translation for zh. */
export function pending(store: StoreLike, epoch: string, lang: Lang = "en"): boolean {
  const cfg = config();
  if (cfg === null) return false;
  const traces = store.listTraces(epoch);
  if (traces.length === 0) return false;
  const [facts] = buildFacts(traces, store.listOutcomes(epoch));
  const hash = digestHash(facts);
  const en = store.getAnalysis(epoch, hash, cfg.model, scopeOf("epoch", "en")) as Obj | null;
  if (lang === "en") return en === null;
  if (en === null) return true;
  const zh = store.getAnalysis(epoch, hash, cfg.model, scopeOf("epoch", "zh")) as Obj | null;
  return zh === null || zh.translated_from !== contentHash(en);
}

/** Run one LLM analysis on a single trajectory digest; returns null without a provider or steps. */
export async function analyzeTrajectory(
  store: StoreLike,
  digestInput: unknown,
  epoch: string | null = null,
  lang: Lang = "en",
): Promise<Obj | null> {
  const cfg = config();
  if (cfg === null || digestInput === null || typeof digestInput !== "object" || Array.isArray(digestInput)) return null;
  let digest = digestInput as Obj;
  const stepList = listOf(digest.steps).filter(step => step !== null && typeof step === "object");
  if (stepList.length === 0) return null;
  // Scoring details are not in the trace, so pull them from the outcome: otherwise "model answered wrong" and "grader missed it" look identical.
  const outcome = epoch ? store.getOutcome(epoch, digest.attempt === undefined ? null : String(digest.attempt)) : null;
  if (outcome !== null) {
    digest = { ...digest };
    const detail: Obj = {};
    for (const key of ["task_id", "success", "reward", "status"]) {
      if (key in outcome) detail[key] = outcome[key];
    }
    if (outcome.verdict_details !== null && outcome.verdict_details !== undefined) {
      detail.verification = outcome.verdict_details;
    }
    digest.outcome = detail;
  }
  // Truncate oversized fields: the model only sees the summary and cannot copy commands/stack traces verbatim.
  digest = shrinkDigest(digest);
  const steps = listOf(digest.steps);
  const refs: Refs = {
    step_ids: new Set(steps.filter(step => step.step_id !== null && step.step_id !== undefined).map(step => String(step.step_id))),
    sessions: new Set(digest.attempt ? [String(digest.attempt)] : []),
    metrics: metricNames(digest),
  };
  const cacheObservable = steps.some(step => isNumber(step.cached_tokens));
  const hash = digestHash(digest);
  const scopeEpoch = epoch ?? "adhoc";
  const enScope = scopeOf("trajectory", "en");
  const zhScope = scopeOf("trajectory", "zh");
  const cached = store.getAnalysis(scopeEpoch, hash, cfg.model, enScope);
  if (cached !== null) {
    STATS.cache_hits += 1;
    const en = cached as Obj;
    return lang === "zh" ? ensureTranslation(store, scopeEpoch, hash, en, zhScope) : en;
  }
  STATS.calls += 1;
  let summary: string;
  let findings: Obj[];
  let dropped: number;
  try {
    const validated = validate(await call(cfg, digest, trajPrompt()), refs);
    summary = validated.summary;
    findings = validated.findings;
    dropped = validated.dropped;
    const filtered = filterNoise(findings, steps.length, cacheObservable);
    findings = filtered.findings;
    dropped += filtered.suppressed;
  } catch (error) {
    STATS.failures += 1;
    STATS.last_error = String(error);
    return {
      source: "rules",
      scope: "trajectory",
      model: cfg.model,
      digest_hash: hash,
      lang,
      generated_at: Date.now() / 1000,
      error: String(error),
      summary: msg(lang, "LLM analysis failed; fell back to rule results", "LLM 分析失败，已回退规则结果"),
      findings: [],
      dropped_findings: 0,
    };
  }
  STATS.dropped += dropped;
  const payload = {
    source: "llm",
    scope: "trajectory",
    model: cfg.model,
    digest_hash: hash,
    lang: "en",
    generated_at: Date.now() / 1000,
    summary,
    findings,
    dropped_findings: dropped,
  };
  store.saveAnalysis(scopeEpoch, hash, cfg.model, payload, enScope);
  return lang === "zh" ? ensureTranslation(store, scopeEpoch, hash, payload, zhScope) : payload;
}

/**
 * Drop findings that current data cannot verify, plus generic items that always hold on short traces.
 *
 * steps=null means an epoch-wide view, where short-trace suppression is skipped: each attempt in
 * an epoch having only 2 steps does not mean the epoch has no latency or efficiency problem.
 */
function filterNoise(findings: Obj[], steps: number | null = null, cacheObservable = true): { findings: Obj[]; suppressed: number } {
  const kept: Obj[] = [];
  let dropped = 0;
  for (const finding of findings) {
    const category = String(finding.category ?? "").toLowerCase();
    if (category === "cache" && !cacheObservable) {
      dropped += 1;
      continue;
    }
    if (steps !== null && (category === "latency" || category === "efficiency") && steps < 3) {
      dropped += 1;
      continue;
    }
    kept.push(finding);
  }
  return { findings: kept, suppressed: dropped };
}

function metricNames(digest: Obj): RefSet {
  const names = new Set<string>(Object.keys(asObject(digest.totals)));
  for (const section of ["inference", "cache", "hardware"]) {
    const block = digest[section];
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      for (const key of Object.keys(block)) names.add(key);
    }
  }
  if (digest.outcome !== null && typeof digest.outcome === "object" && !Array.isArray(digest.outcome)) {
    for (const key of Object.keys(digest.outcome)) names.add(key);
  }
  return names;
}

/**
 * Run one LLM analysis for an epoch; returns null without a provider or traces.
 *
 * force=true skips the cache and recomputes (used by the panel's "Re-analyze" button).
 */
export async function analyzeEpoch(store: StoreLike, epoch: string, force = false, lang: Lang = "en"): Promise<Obj | null> {
  const cfg = config();
  if (cfg === null) return null;
  const traces = store.listTraces(epoch);
  if (traces.length === 0) return null;
  const outcomes = store.listOutcomes(epoch);
  const [facts, refs] = buildFacts(traces, outcomes);
  const hash = digestHash(facts);
  const enScope = scopeOf("epoch", "en");
  const zhScope = scopeOf("epoch", "zh");
  const cached = force ? null : store.getAnalysis(epoch, hash, cfg.model, enScope);
  if (cached !== null) {
    STATS.cache_hits += 1;
    const en = cached as Obj;
    return lang === "zh" ? ensureTranslation(store, epoch, hash, en, zhScope, force) : en;
  }
  STATS.calls += 1;
  let summary: string;
  let findings: Obj[];
  let dropped: number;
  try {
    const validated = validate(await call(cfg, facts, promptFor(facts)), refs);
    summary = validated.summary;
    findings = validated.findings;
    dropped = validated.dropped;
    const filtered = filterNoise(findings, null, Boolean(facts.cache_observable));
    findings = filtered.findings;
    dropped += filtered.suppressed;
  } catch (error) {
    // Network/parse failure: do not cache, fall back to the rule layer.
    STATS.failures += 1;
    STATS.last_error = String(error);
    return {
      source: "rules",
      model: cfg.model,
      digest_hash: hash,
      lang,
      generated_at: Date.now() / 1000,
      error: String(error),
      summary: msg(lang, "LLM analysis failed; fell back to rule results", "LLM 分析失败，已回退规则结果"),
      findings: [],
      dropped_findings: 0,
    };
  }
  STATS.dropped += dropped;
  const payload = {
    source: "llm",
    model: cfg.model,
    digest_hash: hash,
    lang: "en",
    generated_at: Date.now() / 1000,
    summary,
    findings,
    dropped_findings: dropped,
  };
  store.saveAnalysis(epoch, hash, cfg.model, payload, enScope);
  return lang === "zh" ? ensureTranslation(store, epoch, hash, payload, zhScope, force) : payload;
}

async function call(cfg: LlmConfig, facts: Obj, prompt?: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
  const body = JSON.stringify({
    model: cfg.model,
    temperature: 0,
    max_tokens: cfg.max_tokens,
    messages: [
      { role: "system", content: prompt ?? PROMPTS.run },
      { role: "user", content: JSON.stringify(facts) },
    ],
  });

  let response: Response;
  try {
    response = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(cfg.timeout * 1000),
    });
  } catch (error) {
    throw new Error(String(error));
  }
  if (!response.ok) {
    // The provider's error body (e.g. "Consumer is forbidden.") explains the cause better than the status line.
    const detail = (await response.text()).trim().slice(0, 200);
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${detail}`);
  }
  const data = asObject(await response.json() as unknown);
  const choices = listOf(data.choices);
  if (choices.length === 0) throw new Error("model returned no choices");
  const choice = choices[0]!;
  if (String(choice.finish_reason ?? "") === "length") {
    throw new Error("response truncated (finish_reason=length); raise TRACER_LLM_MAX_TOKENS");
  }
  return String(asObject(choice.message).content ?? "");
}

function validate(text: string, refs: Refs): { summary: string; findings: Obj[]; dropped: number } {
  const data = asObject(parse(text));
  const summary = String(data.summary ?? "").trim();
  const valid: Obj[] = [];
  let dropped = 0;
  for (const item of listOf(data.findings)) {
    const finding = validateFinding(item, refs);
    if (finding === null) dropped += 1;
    else valid.push(finding);
  }
  // Keep by severity when over the limit: model ordering is unreliable, so sort before truncating
  // to avoid dropping high items that came later (ties keep the model's relative order).
  valid.sort((a, b) => SEVERITIES.indexOf(a.severity as (typeof SEVERITIES)[number]) - SEVERITIES.indexOf(b.severity as (typeof SEVERITIES)[number]));
  const findings = valid.slice(0, MAX_FINDINGS);
  return { summary, findings, dropped: dropped + valid.length - findings.length };
}

/** Validate one finding; return null when evidence references a nonexistent object (treated as hallucination). */
function validateFinding(item: unknown, refs: Refs): Obj | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Obj;
  const severity = String(record.severity ?? "").toLowerCase();
  const title = String(record.title ?? "").trim();
  if (!(SEVERITIES as readonly string[]).includes(severity) || !title) return null;
  const evidence = asObject(record.evidence);
  if (evidence.step_id !== null && evidence.step_id !== undefined && !refs.step_ids.has(String(evidence.step_id))) return null;
  if (evidence.metric !== null && evidence.metric !== undefined && !refs.metrics.has(String(evidence.metric))) return null;
  if (evidence.session !== null && evidence.session !== undefined && !refs.sessions.has(String(evidence.session))) return null;
  return {
    severity,
    category: String(record.category ?? "analysis"),
    title,
    detail: String(record.detail ?? ""),
    evidence,
    recommendation: String(record.recommendation ?? ""),
  };
}

/** Lenient parsing: accepts plain JSON, ```json code fences, and text with surrounding prose. */
function parse(text: string): unknown {
  let body = (text ?? "").trim();
  if (body.startsWith("```")) {
    body = body.replace(/^`+/, "").replace(/`+$/, "");
    if (body.toLowerCase().startsWith("json")) body = body.slice(4);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // Fall through to the brace scan.
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && start < end) {
    try {
      return JSON.parse(body.slice(start, end + 1)) as unknown;
    } catch {
      // Fall through to the error.
    }
  }
  throw new Error("model did not return JSON");
}
