/** Deterministic rule engine producing OptFeedback signals without any LLM call. */
import { type Lang, msg } from "./i18n.js";
import { round } from "./num.js";

export const ERR_STATUS = new Set(["error", "failed", "failure", "timeout"]);
const SEV_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

const SUCCESS_RATE_MIN = 0.8;
const P95_LATENCY_MS_MAX = 5000.0;
const COST_PER_TASK_MAX = 0.1;
const STEPS_MEAN_MAX = 30;
const SPAN_SHARE_MAX = 0.5;
const CACHE_HIT_MIN = 0.5;
const NPU_UTIL_MIN = 30.0;
const TTFT_P95_MAX = 150.0;
const STEP_SHARE_MAX = 0.3;

type Obj = Record<string, unknown>;

export interface Signal {
  [key: string]: unknown;
  id: string;
  severity: string;
  target: string;
  category: string;
  title: string;
  evidence: Obj;
  detail: string | null;
  suggestion: { direction: string };
}

export interface Finding {
  [key: string]: unknown;
  severity: string;
  category: string;
  title: string;
  detail: string | null;
  recommendation: string | null;
  evidence?: Obj;
}

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isLlm(fn: unknown): boolean {
  return String(fn ?? "").toLowerCase().startsWith("llm");
}

function sig(
  severity: string,
  target: string,
  category: string,
  title: string,
  direction: string,
  evidence: Obj = {},
  detail: string | null = null,
): Signal {
  return {
    id: `${category}.${target}`,
    severity,
    target,
    category,
    title,
    evidence,
    detail,
    suggestion: { direction },
  };
}

function stepSpan(step: Obj): [number | null, number | null] {
  const invocation = asObject(asObject(step.extra).invocation);
  const start = invocation.start_timestamp;
  const end = invocation.end_timestamp;
  if (isNumber(start) && isNumber(end) && end >= start) return [start, end];
  return [null, null];
}

function stepFn(step: Obj): string {
  const ancestry = asObject(asObject(step.extra).ancestry);
  return String(ancestry.function_name ?? step.source ?? "step");
}

function outcomeSignals(population: Obj, outcomes: Obj[], out: Signal[], lang: Lang): void {
  const successRate = population.success_rate;
  if (outcomes.length > 0 && isNumber(successRate) && successRate < SUCCESS_RATE_MIN) {
    const failed = outcomes.filter(outcome => !outcome.success).map(outcome => outcome.task_id);
    out.push(
      sig(
        "high",
        "agent",
        "quality",
        msg(lang, `Success rate ${(successRate * 100).toFixed(1)}%`, `成功率 ${(successRate * 100).toFixed(1)}%`),
        msg(
          lang,
          "Inspect failed task trajectories; fix tool calls and the retry policy first",
          "抽查失败任务的轨迹，优先修工具调用与重试策略",
        ),
        { tasks: population.tasks, success_rate: successRate, metric: "success_rate", failed_tasks: failed.slice(0, 10) },
        msg(
          lang,
          `${failed.length} of ${Number(population.tasks ?? 0)} tasks failed`,
          `${Number(population.tasks ?? 0)} 个任务中 ${failed.length} 个失败`,
        ),
      ),
    );
  }

  const p95 = population.p95_latency_ms;
  if (isNumber(p95) && p95 >= P95_LATENCY_MS_MAX) {
    out.push(
      sig(
        "medium",
        "infra",
        "latency",
        msg(lang, `P95 latency ${p95.toFixed(0)} ms`, `P95 时延 ${p95.toFixed(0)} ms`),
        msg(
          lang,
          "Check queueing and prefill concurrency; scale out or lower the batch cap if needed",
          "检查排队与 prefill 并发，必要时扩容或调低 batch 上限",
        ),
        { p50_latency_ms: population.p50_latency_ms, p95_latency_ms: p95, metric: "p95_latency_ms" },
        `P50 ${Number(population.p50_latency_ms ?? 0).toFixed(0)} ms / P95 ${p95.toFixed(0)} ms`,
      ),
    );
  }

  const tasks = Number(population.tasks ?? 0);
  const cost = population.cost_usd;
  if (tasks > 0 && isNumber(cost) && cost / tasks > COST_PER_TASK_MAX) {
    out.push(
      sig(
        "medium",
        "infra",
        "cost",
        msg(lang, `Cost per task $${(cost / tasks).toFixed(3)}`, `单任务成本 $${(cost / tasks).toFixed(3)}`),
        msg(
          lang,
          "Review cache reuse and the model tier; cut redundant prefill first",
          "评估缓存复用与模型档位，优先压降重复 prefill",
        ),
        { cost_usd: cost, tasks, cost_per_task: round(cost / tasks, 4), metric: "cost_per_task" },
      ),
    );
  }

  const stepsMean = population.steps_mean;
  if (isNumber(stepsMean) && stepsMean > STEPS_MEAN_MAX) {
    out.push(
      sig(
        "medium",
        "harness",
        "efficiency",
        msg(lang, `${stepsMean.toFixed(1)} steps per trajectory on average`, `平均 ${stepsMean.toFixed(1)} 步/轨迹`),
        msg(
          lang,
          "Tighten prompts and the tool set to cut wasted exploration",
          "收敛提示词与工具集，减少无效探索步",
        ),
        {
          steps_mean: stepsMean,
          metric: "steps_mean",
        },
      ),
    );
  }
}

function stepSignals(traces: Obj[], out: Signal[], lang: Lang): void {
  const errors: Obj[] = [];
  const spans = new Map<string, [number, string | null, string | null, number]>();
  let totalSteps = 0;
  let totalDuration = 0;

  for (const trace of traces) {
    if (trace.kind !== "trajectory") continue;
    const payload = asObject(trace.payload);
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    for (const raw of steps) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const step = raw as Obj;
      totalSteps += 1;
      const invocation = asObject(asObject(step.extra).invocation);
      const status = String(invocation.status ?? step.status ?? "").toLowerCase();
      if (ERR_STATUS.has(status)) {
        errors.push({
          session: trace.session,
          step_id: step.step_id,
          function: stepFn(step),
          status,
          error: invocation.error,
        });
      }
      const [start, end] = stepSpan(step);
      if (start !== null && end !== null) {
        const fn = stepFn(step);
        if (!isLlm(fn)) {
          // [accumulated duration, source session, slowest step_id, slowest step duration]
          const acc = spans.get(fn) ?? [0, null, null, 0];
          acc[0] += end - start;
          if (end - start > acc[3]) {
            acc[1] = trace.session === undefined ? null : String(trace.session);
            acc[2] = step.step_id === undefined ? null : String(step.step_id);
            acc[3] = end - start;
          }
          spans.set(fn, acc);
        }
        totalDuration += end - start;
      }
    }
  }

  if (errors.length > 0) {
    const first = errors[0]!;
    const ratio = totalSteps > 0 ? errors.length / totalSteps : 0;
    const severity = ratio >= 0.1 || errors.length >= 3 ? "high" : "medium";
    out.push(
      sig(
        severity,
        "harness",
        "error",
        msg(
          lang,
          `${errors.length} steps failed (${(ratio * 100).toFixed(1)}%)`,
          `${errors.length} 个 step 执行失败（占 ${(ratio * 100).toFixed(1)}%）`,
        ),
        msg(
          lang,
          "Group failures by function; add retries, fallbacks and upfront validation",
          "按 function 聚合失败原因，补重试/降级和前置校验",
        ),
        {
          total_steps: totalSteps,
          error_steps: errors.length,
          // First failing step anchors the root cause; the UI can jump straight to its waterfall row.
          session: first.session,
          step_id: first.step_id,
          samples: errors.slice(0, 5),
        },
        msg(lang, `First failure: ${String(first.function)} / ${String(first.status)}`, `首个失败：${String(first.function)} / ${String(first.status)}`),
      ),
    );
  }

  if (totalDuration > 0 && totalSteps > 1 && spans.size > 0) {
    let topFn = "";
    let topAcc: [number, string | null, string | null, number] | null = null;
    for (const [fn, acc] of spans) {
      if (topAcc === null || acc[0] > topAcc[0]) {
        topFn = fn;
        topAcc = acc;
      }
    }
    if (topAcc !== null) {
      const duration = topAcc[0];
      const share = duration / totalDuration;
      if (share >= SPAN_SHARE_MAX) {
        out.push(
          sig(
            "medium",
            "harness",
            "bottleneck",
            msg(lang, `${topFn} takes ${(share * 100).toFixed(0)}% of total time`, `${topFn} 占全程 ${(share * 100).toFixed(0)}%`),
            msg(
              lang,
              "Split or parallelize this step to reduce serial waiting",
              "拆分或并行化该步骤，减少串行等待",
            ),
            {
              function: topFn,
              share_pct: round(share * 100, 2),
              duration_ms: round(duration * 1000, 2),
              // Jump to the slowest step inside this function: the most representative sample.
              session: topAcc[1],
              step_id: topAcc[2],
            },
            msg(
              lang,
              `${duration.toFixed(2)} s cumulative of ${totalDuration.toFixed(2)} s total`,
              `该函数累计 ${duration.toFixed(2)} s / 全程 ${totalDuration.toFixed(2)} s`,
            ),
          ),
        );
      }
    }
  }
}

function summarySignals(traces: Obj[], out: Signal[], lang: Lang): void {
  const latest = new Map<string, Obj>();
  for (const trace of traces) {
    if (trace.kind === "summary") latest.set(String(trace.session), asObject(trace.payload));
  }
  for (const [session, payload] of latest) {
    const profiling = asObject(payload.profiling ?? payload.profiling_metrics);
    const ttft = asObject(profiling.ttft);
    if (isNumber(ttft.p95) && ttft.p95 > TTFT_P95_MAX) {
      out.push(
        sig(
          "medium",
          "infra",
          "ttft",
          `TTFT p95 ${ttft.p95.toFixed(0)}`,
          msg(
            lang,
            "Check prefill concurrency and KV cache cold start; consider chunked prefill",
            "检查 prefill 并发与 KV cache 冷启动，考虑 chunked prefill",
          ),
          {
            session,
            ttft,
            metric: "ttft.p95",
          },
        ),
      );
    }

    const telemetry = asObject(payload.telemetry);
    const sources = Array.isArray(telemetry.sources) ? telemetry.sources : [];
    for (const raw of sources) {
      const source = asObject(raw);
      const series = new Map<string, Obj>();
      const items = Array.isArray(source.series) ? source.series : [];
      for (const item of items) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          series.set(String((item as Obj).metric), item as Obj);
        }
      }
      if (source.kind === "vllm") {
        const queries = asObject(series.get("vllm:prefix_cache_queries")).total;
        const hits = asObject(series.get("vllm:prefix_cache_hits")).total;
        if (isNumber(queries) && queries > 0 && isNumber(hits)) {
          const hit = hits / queries;
          if (hit < CACHE_HIT_MIN) {
            out.push(
              sig(
                "medium",
                "infra",
                "cache",
                msg(lang, `Prefix cache hit rate ${(hit * 100).toFixed(0)}%`, `prefix cache 命中率 ${(hit * 100).toFixed(0)}%`),
                msg(lang, "Unify the system prompt prefix to improve cache reuse", "统一 system prompt 前缀，提高缓存复用"),
                { session, queries, hits, hit_rate: round(hit, 4), metric: "vllm:prefix_cache_hits" },
              ),
            );
          }
        }
      }
      if (source.kind === "ascend") {
        const util = asObject(series.get("ascend_npu_utilization_percent"));
        if (isNumber(util.mean) && util.mean < NPU_UTIL_MIN) {
          out.push(
            sig(
              "medium",
              "infra",
              "utilization",
              msg(lang, `Average NPU utilization ${util.mean.toFixed(0)}%`, `NPU 平均利用率 ${util.mean.toFixed(0)}%`),
              msg(lang, "Raise batch concurrency to saturate compute", "提高并发 batch，让算力打满"),
              {
                session,
                mean: util.mean,
                max: util.max,
                metric: "ascend_npu_utilization_percent",
              },
            ),
          );
        }
      }
    }
  }
}

export function buildSignals(traces: Obj[], outcomes: Obj[], population: Obj, lang: Lang = "en"): Signal[] {
  const out: Signal[] = [];
  outcomeSignals(population ?? {}, outcomes ?? [], out, lang);
  stepSignals(traces ?? [], out, lang);
  summarySignals(traces ?? [], out, lang);
  out.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  return out;
}

/** Run rule analysis over a digest submitted by the frontend; returns {summary, scores, findings}. */
export function analyzeDigest(
  digest: unknown,
  lang: Lang = "en",
): { [key: string]: unknown; summary: string; scores: null; findings: Finding[] } {
  const d = asObject(digest);
  const steps = Array.isArray(d.steps) ? d.steps.map(asObject) : [];
  const total = steps.reduce((sum, step) => sum + Number(step.dur ?? 0), 0) || 1.0;
  const findings: Finding[] = [];

  for (const step of steps) {
    if (step.error) {
      findings.push({
        severity: "high",
        category: "error",
        title: msg(lang, `${String(step.fn ?? "step")} failed`, `${String(step.fn ?? "step")} 执行失败`),
        detail: String(step.error),
        recommendation: msg(lang, "Check tool dependencies and the retry policy", "检查工具依赖与重试策略"),
        evidence: { step_id: step.step_id },
      });
    } else if (steps.length > 1 && !isLlm(step.fn) && Number(step.dur ?? 0) / total >= STEP_SHARE_MAX) {
      findings.push({
        severity: "high",
        category: "bottleneck",
        title: msg(
          lang,
          `${String(step.fn ?? "step")} takes ${((Number(step.dur ?? 0) / total) * 100).toFixed(0)}% of total time`,
          `${String(step.fn ?? "step")} 占全程 ${((Number(step.dur ?? 0) / total) * 100).toFixed(0)}%`,
        ),
        detail: msg(
          lang,
          `${Number(step.dur ?? 0).toFixed(2)} s of ${total.toFixed(2)} s total`,
          `该步 ${Number(step.dur ?? 0).toFixed(2)} s / 总 ${total.toFixed(2)} s`,
        ),
        recommendation: msg(lang, "Consider splitting or parallelizing this step", "考虑拆分或并行化该步骤"),
        evidence: { step_id: step.step_id },
      });
    }
  }

  const cache = asObject(d.cache);
  const queries = asObject(cache["vllm:prefix_cache_queries"]).total;
  const hits = asObject(cache["vllm:prefix_cache_hits"]).total;
  if (isNumber(queries) && queries > 0 && isNumber(hits) && hits / queries < CACHE_HIT_MIN) {
    findings.push({
      severity: "medium",
      category: "cache",
      title: msg(
        lang,
        `Prefix cache hit rate only ${((hits / queries) * 100).toFixed(0)}%`,
        `prefix cache 命中率仅 ${((hits / queries) * 100).toFixed(0)}%`,
      ),
      detail: `${Math.trunc(hits)}/${Math.trunc(queries)} tokens`,
      recommendation: msg(lang, "Unify the system prompt prefix to improve reuse", "统一 system prompt 前缀以提高复用"),
      evidence: { metric: "vllm:prefix_cache_hits" },
    });
  }

  const hardware = asObject(d.hardware);
  const npu = asObject(hardware.ascend_npu_utilization_percent);
  if (isNumber(npu.mean) && npu.mean < NPU_UTIL_MIN) {
    findings.push({
      severity: "medium",
      category: "utilization",
      title: msg(lang, `NPU utilization is low (mean ${npu.mean.toFixed(0)}%)`, `NPU 利用率偏低 (mean ${npu.mean.toFixed(0)}%)`),
      detail: `max ${String(npu.max)}%`,
      recommendation: msg(lang, "Raise batch concurrency to saturate compute", "提高并发 batch 以打满算力"),
      evidence: { metric: "ascend_npu_utilization_percent" },
    });
  }

  const ttft = asObject(asObject(d.inference).ttft);
  if (isNumber(ttft.p95) && ttft.p95 > TTFT_P95_MAX) {
    findings.push({
      severity: "medium",
      category: "latency",
      title: msg(lang, `TTFT p95 is high (${String(ttft.p95)})`, `TTFT p95 偏高 (${String(ttft.p95)})`),
      detail: msg(lang, "Requests may be queueing during prefill", "prefill 阶段可能排队"),
      recommendation: msg(
        lang,
        "Check prefill concurrency, chunked prefill and KV cache cold start",
        "检查 prefill 并发 / chunked prefill / KV cache 冷启动",
      ),
      evidence: { metric: "ttft.p95" },
    });
  }

  if (steps.length > STEPS_MEAN_MAX) {
    findings.push({
      severity: "low",
      category: "efficiency",
      title: msg(lang, `${steps.length} steps in one trajectory is too long`, `单条轨迹 ${steps.length} 步，偏长`),
      detail: msg(lang, "Check for repeated exploration", "检查是否存在重复探索"),
      recommendation: msg(lang, "Tighten prompts and the tool set", "收敛提示词与工具集"),
      evidence: { steps: steps.length },
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "low",
      category: "summary",
      title: msg(lang, "No obvious anomalies found", "未发现明显异常"),
      detail: msg(lang, "No anomalies found in the trajectory or metrics", "轨迹与指标未发现异常"),
      recommendation: "—",
    });
  }

  return { summary: msg(lang, "Rule analysis (no LLM call)", "规则分析（未调用 LLM）"), scores: null, findings };
}

export function signalsToFindings(signals: Signal[]): Finding[] {
  return signals.map(signal => ({
    severity: signal.severity,
    category: signal.category,
    title: signal.title,
    detail: signal.detail,
    recommendation: asObject(signal.suggestion).direction as string,
    evidence: signal.evidence ?? {},
  }));
}
