/** Aggregate traces/outcomes into a population, then build the OptFeedback payload. */
import { findParent, computeDelta } from "./delta.js";
import { type Lang, msg } from "./i18n.js";
import { round } from "./num.js";
import { makeFeedback } from "./schema.js";
import { buildSignals } from "./signals.js";

const PERF_TTFT_P95_MS = 1000.0;
const PERF_CACHE_HIT_MIN = 0.5;
const PERF_NPU_UTIL_MIN = 30.0;
const PERF_AICORE_UTIL_MIN = 30.0;
// vLLM reserves memory up front via gpu-memory-utilization, so HBM usage sits near 90% most of the time;
// only near the ceiling is it worth flagging, otherwise every profiling run raises a false alarm.
const PERF_HBM_USAGE_MAX = 95.0;
const PERF_TEMP_C_MAX = 80.0;
const PERF_SCALE_EFF_MIN = 0.6;
const PERF_GROW_MAX = 1.5;
const PERF_ITL_GROW_MAX = 2.0;

const PERF_DELTA_KEYS = [
  "ttft_p50",
  "ttft_p95",
  "itl_mean",
  "throughput",
  "interactivity",
  "cache_hit",
  "npu_util",
  "aicore_util",
  "hbm_usage",
  "temperature",
] as const;

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

type Obj = Record<string, unknown>;

interface StoreLike {
  listTraces(epoch: string, session?: string | null, limit?: number | null, offset?: number): Obj[];
  listOutcomes(epoch: string): Obj[];
  findRunByCandidate(candidateId: string, excludeEpoch?: string | null): Obj | null;
}

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function valuesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const k = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  if (lo === hi) return round(sorted[lo]!, 3);
  const lower = sorted[lo]!;
  const upper = sorted[hi]!;
  return round(lower + (upper - lower) * (k - lo), 3);
}

function span(step: Obj): [number | null, number | null] {
  const invocation = asObject(asObject(step.extra).invocation);
  const start = invocation.start_timestamp;
  const end = invocation.end_timestamp;
  if (isNumber(start) && isNumber(end) && end >= start) return [start, end];
  const timestamp = step.timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (!Number.isNaN(parsed)) return [parsed / 1000, parsed / 1000];
    return [null, null];
  }
  return [null, null];
}

/** Fall back to the trajectory's first-to-last span (ms) when the outcome carries no latency_ms. */
function taskLatency(traces: Obj[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const trace of traces) {
    if (trace.kind !== "trajectory") continue;
    const body = asObject(trace.payload);
    const starts: number[] = [];
    const ends: number[] = [];
    for (const raw of valuesOf(body.steps)) {
      const [a, b] = span(asObject(raw));
      if (a !== null && b !== null && b >= a) {
        starts.push(a);
        ends.push(b);
      }
    }
    if (starts.length > 0 && Math.max(...ends) > Math.min(...starts)) {
      const value = (Math.max(...ends) - Math.min(...starts)) * 1000;
      // Legacy outcomes may lack attempt_id, so fall back to the trajectory's task_id for pairing.
      for (const key of ["attempt_id", "session_id", "task_id"]) {
        const field = body[key];
        if (field) out.set(String(field), value);
      }
      const session = String(trace.session ?? "");
      if (!out.has(session)) out.set(session, value);
    }
  }
  return out;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function population(traces: Obj[], outcomes: Obj[]): Obj {
  const latenciesByTask = traces && traces.length > 0 ? taskLatency(traces) : new Map<string, number>();
  const latencies: number[] = [];
  for (const outcome of outcomes) {
    let value = outcome.latency_ms ?? outcome.latencyMs;
    if (value === null || value === undefined) {
      value = latenciesByTask.get(String(outcome.attempt_id ?? "")) ?? latenciesByTask.get(String(outcome.session ?? ""));
      if (value === null || value === undefined) value = latenciesByTask.get(String(outcome.task_id ?? ""));
    }
    if (value !== null && value !== undefined) latencies.push(Number(value));
  }
  const rewards = outcomes.filter(outcome => outcome.reward !== null && outcome.reward !== undefined).map(outcome => Number(outcome.reward));
  const successes = outcomes.map(outcome => (outcome.success ? 1 : 0));
  const costs = outcomes.filter(outcome => outcome.cost_usd !== null && outcome.cost_usd !== undefined).map(outcome => Number(outcome.cost_usd));
  const stepsCounts: number[] = [];
  const spans = new Map<string, [number, number]>();
  for (const trace of traces ?? []) {
    if (trace.kind !== "trajectory") continue;
    const body = valuesOf(asObject(trace.payload).steps);
    stepsCounts.push(body.length);
    for (const raw of body) {
      const step = asObject(raw);
      const ancestry = asObject(asObject(step.extra).ancestry);
      const fn = String(ancestry.function_name ?? step.source ?? "step");
      const [a, b] = span(step);
      // Instant steps (user input, events with only a timestamp and no interval) always take 0ms;
      // listing them under Top Spans would just add a 0% row with no diagnostic value.
      if (a === null || b === null || b <= a) continue;
      const acc = spans.get(fn) ?? [0, 0];
      acc[0] += b - a;
      acc[1] += 1;
      spans.set(fn, acc);
    }
  }
  const total = [...spans.values()].reduce((sum, acc) => sum + acc[0], 0) || 1.0;
  const top = [...spans.entries()]
    .sort((a, b) => b[1][0] - a[1][0])
    .slice(0, 20)
    .map(([fn, acc]) => ({
      function: fn,
      mean_ms: round((acc[0] / acc[1]) * 1000, 2),
      share_pct: round((acc[0] / total) * 100, 2),
    }));
  return {
    tasks: outcomes.length,
    success_rate: successes.length > 0 ? round(mean(successes), 4) : null,
    reward_mean: rewards.length > 0 ? round(mean(rewards), 4) : null,
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
    cost_usd: costs.length > 0 ? round(costs.reduce((sum, cost) => sum + cost, 0), 6) : null,
    steps_mean: stepsCounts.length > 0 ? round(mean(stepsCounts), 2) : null,
    trajectories: (traces ?? []).filter(trace => trace.kind === "trajectory").length,
    top_spans: top,
  };
}

/** Aggregate token usage. Without a price table cost is always 0, so tokens are the meaningful scale. */
export function tokenTotals(outcomes: Obj[] | null | undefined): Obj | null {
  const total = { input: 0, output: 0, total: 0 };
  for (const outcome of outcomes ?? []) {
    const usage = outcome.tokens;
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) continue;
    total.input += Math.trunc(Number((usage as Obj).inputTokens ?? 0) || 0);
    total.output += Math.trunc(Number((usage as Obj).outputTokens ?? 0) || 0);
  }
  if (!(total.input || total.output)) return null;
  total.total = total.input + total.output;
  return total;
}

/**
 * agentx profiling has only lifecycle events and no agent steps.
 *
 * For such runs tasks / success rate / latency / steps are all empty metrics and must not
 * be shown as real execution results; confirm via summary workload.kind and trajectory steps.
 */
export function isProfilingRun(traces: Obj[] | null | undefined): boolean {
  const list = traces ?? [];
  const trajectories = list.filter(trace => trace.kind === "trajectory");
  if (trajectories.length === 0) return false;
  if (trajectories.some(trace => valuesOf(asObject(trace.payload).steps).length > 0)) return false;
  const summaries = list.filter(trace => trace.kind === "summary");
  const kinds = new Set(
    summaries.map(trace => String(asObject(asObject(trace.payload).workload).kind)),
  );
  return summaries.length > 0 && kinds.size === 1 && kinds.has("agentx");
}

function perfStat(profiling: Obj, key: string, field = "mean"): number | null {
  const value = asObject(asObject(profiling)[key])[field];
  return isNumber(value) ? value : null;
}

function tierLabel(concurrency: unknown, lang: Lang): string {
  return Number.isInteger(concurrency) ? `c${String(concurrency)}` : msg(lang, "single", "单档");
}

function fmtMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`;
}

/** Translate profiling metrics into deterministic optimization advice the RSI flow can consume directly. */
function perfAdvice(tiers: Obj[], lang: Lang): Obj[] {
  const out: Obj[] = [];
  const paren = (text: string): string => (lang === "zh" ? `（${text}）` : ` (${text})`);
  const add = (
    severity: string,
    metric: string,
    value: string,
    action: string,
    reason: string | null = null,
  ): void => {
    out.push({ severity, target: "infra", metric, value, action, reason });
  };

  const hot = tiers.filter(row => row.ttft_p95 !== null && row.ttft_p95 !== undefined && Number(row.ttft_p95) > PERF_TTFT_P95_MS);
  if (hot.length > 0) {
    const row = hot.reduce((best, item) => (Number(item.ttft_p95) > Number(best.ttft_p95) ? item : best));
    add(
      "high",
      msg(lang, "TTFT p95", "TTFT p95"),
      `${fmtMs(Number(row.ttft_p95))}${paren(tierLabel(row.concurrency, lang))}`,
      msg(
        lang,
        "Check prefill concurrency and KV cache cold start; consider chunked prefill or a lower per-batch sequence length",
        "检查 prefill 并发与 KV cache 冷启动，考虑 chunked prefill 或限制单批序列长度",
      ),
      msg(
        lang,
        "Time to first token is high; long prompts amplify queueing",
        "首 token 等待偏高，长 prompt 会放大排队",
      ),
    );
  }

  const lowCache = tiers.filter(row => row.cache_hit !== null && row.cache_hit !== undefined && Number(row.cache_hit) < PERF_CACHE_HIT_MIN);
  if (lowCache.length > 0) {
    const row = lowCache.reduce((best, item) => (Number(item.cache_hit) < Number(best.cache_hit) ? item : best));
    add(
      "medium",
      msg(lang, "Prefix cache hit rate", "prefix cache 命中率"),
      `${(Number(row.cache_hit) * 100).toFixed(0)}%${paren(tierLabel(row.concurrency, lang))}`,
      msg(
        lang,
        "Unify the system prompt / tool description prefix to improve cache reuse",
        "统一 system prompt / 工具描述前缀，提高缓存复用",
      ),
      msg(lang, "Repeated prefill raises TTFT and compute cost", "重复 prefill 会增加 TTFT 与算力消耗"),
    );
  }

  const lowUtil = tiers.filter(row => row.npu_util !== null && row.npu_util !== undefined && Number(row.npu_util) < PERF_NPU_UTIL_MIN);
  if (lowUtil.length > 0) {
    const row = lowUtil.reduce((best, item) => (Number(item.npu_util) < Number(best.npu_util) ? item : best));
    add(
      "medium",
      msg(lang, "NPU utilization", "NPU 利用率"),
      `${Number(row.npu_util).toFixed(0)}%${paren(tierLabel(row.concurrency, lang))}`,
      msg(lang, "Raise batch concurrency or request count to saturate compute", "提高并发 batch 或请求数，让算力打满"),
      msg(
        lang,
        "The NPU is idle for long stretches; throughput is limited by scheduling, not compute",
        "NPU 长时间空闲，吞吐受调度而非算力限制",
      ),
    );
  }

  const lowCore = tiers.filter(row => row.aicore_util !== null && row.aicore_util !== undefined && Number(row.aicore_util) < PERF_AICORE_UTIL_MIN);
  if (lowCore.length > 0) {
    const row = lowCore.reduce((best, item) => (Number(item.aicore_util) < Number(best.aicore_util) ? item : best));
    add(
      "medium",
      msg(lang, "AI Core utilization", "AI Core 利用率"),
      `${Number(row.aicore_util).toFixed(0)}%${paren(tierLabel(row.concurrency, lang))}`,
      msg(
        lang,
        "Check kernel dispatch and scheduling; make sure batch / sequence length match the workload",
        "检查算子下发与调度，确认 batch / 序列长度匹配负载特征",
      ),
      msg(
        lang,
        "AI Cores are not saturated; kernels or scheduling may be idling",
        "AI Core 未跑满，可能存在算子或调度空转",
      ),
    );
  }

  const highHbm = tiers.filter(row => row.hbm_usage !== null && row.hbm_usage !== undefined && Number(row.hbm_usage) > PERF_HBM_USAGE_MAX);
  if (highHbm.length > 0) {
    const row = highHbm.reduce((best, item) => (Number(item.hbm_usage) > Number(best.hbm_usage) ? item : best));
    add(
      "high",
      msg(lang, "HBM usage", "HBM 占用"),
      `${Number(row.hbm_usage).toFixed(0)}%${paren(tierLabel(row.concurrency, lang))}`,
      msg(
        lang,
        "Lower max-model-len / batch or check for memory leaks to avoid constant swapping",
        "下调 max-model-len / batch 或检查显存泄漏，避免频繁换入换出",
      ),
      msg(
        lang,
        "Memory close to the limit slows decode and raises OOM risk",
        "显存接近上限会拖慢 decode 并增加 OOM 风险",
      ),
    );
  }

  const hotTemp = tiers.filter(row => row.temperature !== null && row.temperature !== undefined && Number(row.temperature) > PERF_TEMP_C_MAX);
  if (hotTemp.length > 0) {
    const row = hotTemp.reduce((best, item) => (Number(item.temperature) > Number(best.temperature) ? item : best));
    add(
      "medium",
      msg(lang, "NPU temperature", "NPU 温度"),
      `${Number(row.temperature).toFixed(0)}°C${paren(tierLabel(row.concurrency, lang))}`,
      msg(
        lang,
        "Check cooling and the power cap to rule out throttling-induced throughput swings",
        "检查散热与功耗墙，确认没有因降频导致吞吐波动",
      ),
      msg(
        lang,
        "High temperature triggers throttling, so metrics may drift over time",
        "高温会触发降频，指标可能随运行时长漂移",
      ),
    );
  }

  const points = tiers.filter(row => row.throughput && row.concurrency);
  if (points.length >= 2) {
    const a = points[0]!;
    const b = points[points.length - 1]!;
    const concurrencyA = Number(a.concurrency);
    const concurrencyB = Number(b.concurrency);
    if (concurrencyB > concurrencyA && Number(a.throughput) > 0) {
      const ratio = Number(b.throughput) / Number(a.throughput);
      const efficiency = ratio / (concurrencyB / concurrencyA);
      if (efficiency < PERF_SCALE_EFF_MIN) {
        add(
          "medium",
          msg(lang, "Concurrency scaling efficiency", "并发扩展效率"),
          `${(efficiency * 100).toFixed(0)}%${paren(
            msg(
              lang,
              `c${concurrencyA}→c${concurrencyB} throughput ${ratio.toFixed(2)}x`,
              `c${concurrencyA}→c${concurrencyB} 吞吐 ${ratio.toFixed(2)}x`,
            ),
          )}`,
          msg(
            lang,
            "Check scheduling and the batch policy; look for prefill / decode contention and queueing",
            "检查调度与 batch 策略，排查 prefill / decode 争抢与队列等待",
          ),
          msg(
            lang,
            "Concurrency rose but throughput did not scale; compute is not being used effectively",
            "并发提升但吞吐未同比提升，算力没有有效利用",
          ),
        );
      }
    }
    if (a.ttft_p95 && b.ttft_p95 && Number(b.ttft_p95) / Number(a.ttft_p95) >= PERF_GROW_MAX) {
      add(
        "medium",
        msg(lang, "TTFT p95 grows with concurrency", "TTFT p95 随并发增长"),
        `${fmtMs(Number(a.ttft_p95))} → ${fmtMs(Number(b.ttft_p95))}${paren(`c${concurrencyA}→c${concurrencyB}`)}`,
        msg(
          lang,
          "Cap concurrency or split prefill batches to cut first-token queueing",
          "限制并发或拆分 prefill 批次，降低首 token 排队",
        ),
        msg(lang, "First-token latency rises sharply with concurrency", "并发升高后首 token 明显变慢"),
      );
    }
    if (a.itl_mean && b.itl_mean && Number(b.itl_mean) / Number(a.itl_mean) >= PERF_ITL_GROW_MAX) {
      add(
        "medium",
        msg(lang, "ITL slows down with concurrency", "ITL 随并发变慢"),
        `${fmtMs(Number(a.itl_mean))} → ${fmtMs(Number(b.itl_mean))}${paren(`c${concurrencyA}→c${concurrencyB}`)}`,
        msg(
          lang,
          "Check KV cache bandwidth and the batch cap to reduce decode queueing",
          "检查 KV cache 带宽与 batch 上限，降低 decode 阶段排队",
        ),
        msg(lang, "Per-token latency rises sharply with concurrency", "并发升高后逐 token 延迟明显上升"),
      );
    }
  }

  out.sort((a, b) => (SEVERITY_ORDER[String(a.severity)] ?? 9) - (SEVERITY_ORDER[String(b.severity)] ?? 9));
  return out;
}

function numberDelta(current: unknown, previous: unknown): Obj | null {
  if (!isNumber(current) || !isNumber(previous)) return null;
  return {
    abs: round(current - previous, 4),
    pct: previous ? round(((current - previous) / previous) * 100, 1) : null,
  };
}

/** Parent comparison for profiling: align by concurrency tier and compute diff and percentage per metric. */
export function perfDelta(currentTiers: Obj[] | null | undefined, parentTiers: Obj[] | null | undefined): Obj[] {
  const byConcurrency = new Map<unknown, Obj>();
  for (const row of parentTiers ?? []) byConcurrency.set(row.concurrency, row);
  const rows: Obj[] = [];
  for (const current of currentTiers ?? []) {
    const previous = byConcurrency.get(current.concurrency) ?? {};
    rows.push({
      concurrency: current.concurrency,
      current: Object.fromEntries(PERF_DELTA_KEYS.map(key => [key, current[key]])),
      parent: Object.fromEntries(PERF_DELTA_KEYS.map(key => [key, previous[key]])),
      delta: Object.fromEntries(PERF_DELTA_KEYS.map(key => [key, numberDelta(current[key], previous[key])])),
    });
  }
  return rows;
}

/**
 * Aggregate profiling metrics by concurrency tier and generate optimization advice.
 *
 * Profiling runs are also RSI optimization targets, so the feedback page must not merely
 * point users at the metrics view; metrics and deterministic advice ship together so the
 * page can show actionable items directly.
 */
export function profilingPerf(traces: Obj[] | null | undefined, lang: Lang = "en"): Obj {
  const tiers: Obj[] = [];
  for (const trace of traces ?? []) {
    if (trace.kind !== "summary") continue;
    const summary = asObject(trace.payload);
    const workload = asObject(summary.workload);
    const profiling = asObject(summary.profiling ?? summary.profiling_metrics);
    const concurrency = workload.concurrency;
    const row: Obj = {
      concurrency: Number.isInteger(concurrency) ? concurrency : null,
      // One concurrency tier may have several summaries (multiple attempts / reruns);
      // carrying the source session lets load fields map back to their exact row.
      session: trace.session,
      ttft_p50: perfStat(profiling, "ttft", "p50"),
      ttft_p95: perfStat(profiling, "ttft", "p95"),
      itl_mean: perfStat(profiling, "itl", "mean"),
      latency_p95: perfStat(profiling, "requestLatency", "p95"),
      throughput: perfStat(profiling, "totalThroughput", "mean"),
      interactivity: perfStat(profiling, "interactivity", "mean"),
      cache_hit: null,
      npu_util: null,
      aicore_util: null,
      hbm_usage: null,
      temperature: null,
    };
    for (const raw of valuesOf(asObject(summary.telemetry).sources)) {
      const source = asObject(raw);
      const series = new Map<string, Obj>();
      for (const item of valuesOf(source.series)) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          series.set(String((item as Obj).metric), item as Obj);
        }
      }
      if (source.kind === "vllm") {
        const queries = asObject(series.get("vllm:prefix_cache_queries")).total;
        const hits = asObject(series.get("vllm:prefix_cache_hits")).total;
        if (isNumber(queries) && queries > 0 && isNumber(hits)) row.cache_hit = hits / queries;
      } else if (source.kind === "ascend") {
        const seriesMean = (key: string): unknown => {
          const value = asObject(series.get(key)).mean;
          return isNumber(value) ? value : null;
        };
        const npuUtil = seriesMean("ascend_npu_utilization_percent");
        const aicoreUtil = seriesMean("ascend_npu_aicore_utilization_percent");
        const hbmUsage = seriesMean("ascend_npu_hbm_usage_percent");
        const temperature = seriesMean("ascend_npu_temperature_celsius");
        row.npu_util = npuUtil;
        row.aicore_util = aicoreUtil;
        row.hbm_usage = hbmUsage;
        row.temperature = temperature;
      }
    }
    tiers.push(row);
  }
  tiers.sort((a, b) => {
    const aNull = a.concurrency === null ? 1 : 0;
    const bNull = b.concurrency === null ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    return Number(a.concurrency ?? 0) - Number(b.concurrency ?? 0);
  });
  return { tiers, advice: perfAdvice(tiers, lang) };
}

/**
 * Concurrency tiers of a profiling run, rendered directly by the feedback page.
 *
 * The frontend derives tiers from the local summary replayed over SSE, which is not ready
 * right after an epoch switch and would show only one tier; serving it from the server
 * avoids that mismatch.
 */
export function profilingConcurrency(traces: Obj[] | null | undefined): number[] {
  const values = new Set<number>();
  for (const trace of traces ?? []) {
    if (trace.kind !== "summary") continue;
    const concurrency = asObject(asObject(trace.payload).workload).concurrency;
    if (isNumber(concurrency)) values.add(Math.trunc(concurrency));
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Parent comparison for profiling: align metrics per concurrency tier; null means no comparable parent.
 *
 * A normal run's delta_vs_parent compares task success rate / latency, but agentx has no task
 * results, so only inference and hardware metrics can be compared; downstream uses this to tell
 * whether the tuning actually helped.
 */
export function attachParentPerf(
  perf: Obj,
  epoch: string,
  run: Obj | null,
  store: StoreLike | null,
  lang: Lang = "en",
): Obj | null {
  if (store === null || !run || !run.parent_id) return null;
  const [parentEpoch] = findParent(store, epoch, run);
  if (!parentEpoch) return null;
  const parentTraces = store.listTraces(parentEpoch);
  const parentPerf = profilingPerf(parentTraces, lang);
  const out: Obj = {
    epoch: parentEpoch,
    profiling: isProfilingRun(parentTraces),
    tiers: perfDelta(valuesOf(perf.tiers) as Obj[], valuesOf(parentPerf.tiers) as Obj[]),
  };
  if (!out.profiling) {
    out.note = msg(
      lang,
      "The parent run is not a profiling run, so there are no inference or hardware metrics to compare",
      "父轮次不是 profiling run，没有推理/硬件指标可对比",
    );
  }
  return out;
}

export function buildFeedback(
  epoch: string,
  run: Obj | null,
  traces: Obj[],
  outcomes: Obj[],
  store: StoreLike | null = null,
  lang: Lang = "en",
): Obj {
  const pop = population(traces, outcomes);
  const signals = buildSignals(traces, outcomes, pop, lang);
  let delta: Obj | null = null;
  let explain: string | null = null;
  let parentEpoch: string | null = null;
  if (store !== null && run && run.parent_id) {
    const [resolvedEpoch, parentRun] = findParent(store, epoch, run);
    parentEpoch = resolvedEpoch;
    if (parentEpoch) {
      const parentPopulation = population(store.listTraces(parentEpoch), store.listOutcomes(parentEpoch));
      [delta, explain] = computeDelta(run, pop, parentRun, parentPopulation, parentEpoch, lang);
    } else {
      explain = msg(
        lang,
        `No parent run found for candidate ${String(run.parent_id)}, so no version comparison is possible.`,
        `未找到候选 ${String(run.parent_id)} 对应的父轮次，无法做版本对比。`,
      );
    }
  }
  const feedback = makeFeedback(epoch, run, pop, signals, delta, explain) as unknown as Obj;
  // Lets the frontend distinguish profiling runs so tasks=0 / steps=0 are not read as real execution results.
  feedback.profiling = isProfilingRun(traces);
  if (feedback.profiling) {
    feedback.profiling_concurrency = profilingConcurrency(traces);
    // Inference performance is also an RSI optimization target: ship metrics and advice together to the feedback page.
    const perf = profilingPerf(traces, lang);
    // Profiling runs compare against the parent too, but on per-tier performance metrics rather than success rate.
    if (parentEpoch) {
      const parent = attachParentPerf(perf, epoch, run, store, lang);
      if (parent) perf.parent = parent;
    }
    feedback.perf = perf;
  }
  // Only goes into the returned payload, never into population: otherwise the LLM facts digest changes and every old analysis is invalidated.
  feedback.tokens = tokenTotals(outcomes);
  return feedback;
}
