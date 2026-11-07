/** Evaluation conclusion engine shared by the dashboard and the RSI optimizer. */
import { tokenTotals } from "./aggregate.js";
import { MIN_TASKS, SUCCESS_EPS } from "./delta.js";
import { type Lang, msg } from "./i18n.js";
import { round } from "./num.js";
import { ERR_STATUS } from "./signals.js";

export const SCHEMA_VERSION = "EvalConclusion";
const RULES_VERSION = 2;
// Task-level comparison (pass -> fail) holds even on small samples, but confidence must be tiered by sample size.
const TASK_SAMPLE_MEDIUM = 5;
// Below this many common tasks a task-level flip cannot veto a whole round: one task moving is not a regression.
const TASK_SAMPLE_MIN = 3;
// success unchanged but reward clearly down: 20% relative plus 0.1 absolute, avoiding percentage noise on small baselines.
const REWARD_REL_DROP = 0.2;
const REWARD_ABS_DROP = 0.1;
const MAX_ACTIONS = 5;
const MAX_CHALLENGES = 4;
const MAX_EVIDENCE_TASKS = 10;
const MAX_STEP_IDS = 500;

const DECISION_LABEL: Record<Lang, Record<string, string>> = {
  en: { accept: "Accepted", reject: "Rejected", inconclusive: "Inconclusive" },
  zh: { accept: "通过", reject: "拒绝", inconclusive: "待定" },
};
const CONFIDENCE_LABEL: Record<Lang, Record<string, string>> = {
  en: { high: "high", medium: "medium", low: "low" },
  zh: { high: "高", medium: "中", low: "低" },
};

type Obj = Record<string, unknown>;

interface ParentRef {
  epoch?: unknown;
  outcomes?: Obj[] | null;
}

interface AnalysisLike {
  source?: unknown;
  model?: unknown;
  summary?: unknown;
  findings?: Obj[];
}

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isRecord(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function listOf(value: unknown): Obj[] {
  return Array.isArray(value) ? (value as Obj[]) : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function verdict(decision: string, confidence: string, code: string, text: string, evidence: Obj = {}): Obj {
  return { decision, confidence, reasons: [{ code, text, evidence }] };
}

function confidence(nTasks: number): string {
  if (nTasks >= MIN_TASKS) return "high";
  if (nTasks >= TASK_SAMPLE_MEDIUM) return "medium";
  return "low";
}

function taskMap(outcomes: Obj[] | null | undefined): Map<string, Obj> {
  const map = new Map<string, Obj>();
  for (const outcome of outcomes ?? []) {
    if (outcome.task_id) map.set(String(outcome.task_id), outcome);
  }
  return map;
}

/** Compare per task: a pass/fail flip is a hard regression, a clear reward drop is a soft one (an early quality signal). */
function taskDiff(current: Map<string, Obj>, parent: Map<string, Obj>): [string[], string[], Obj[]] {
  const regressed: string[] = [];
  const improved: string[] = [];
  const drops: Obj[] = [];
  for (const [taskId, outcome] of current) {
    const previous = parent.get(taskId);
    if (previous === undefined) continue;
    const currentOk = Boolean(outcome.success);
    const previousOk = Boolean(previous.success);
    if (previousOk && !currentOk) {
      regressed.push(taskId);
      continue;
    }
    if (currentOk && !previousOk) {
      improved.push(taskId);
      continue;
    }
    // When pass/fail is unchanged, a continuous reward decline is invisible to the success boolean.
    const before = previous.reward;
    const after = outcome.reward;
    if (!isNumber(before) || !isNumber(after)) continue;
    const drop = before - after;
    if (before > 0 && drop >= REWARD_ABS_DROP && drop / Math.abs(before) >= REWARD_REL_DROP) {
      drops.push({ task_id: taskId, before: round(before, 4), after: round(after, 4), delta: round(-drop, 4) });
    }
  }
  drops.sort((a, b) => Number(a.delta) - Number(b.delta));
  return [regressed.sort(), improved.sort(), drops];
}

/** Split delta into worse / better buckets; only judge when the overall delta is significant. */
function metricChanges(delta: Obj | null): [Obj[], Obj[]] {
  if (!delta || !delta.significant) return [[], []];
  const values = asObject(delta.values);
  const current = asObject(values.current);
  const previous = asObject(values.parent);
  const worse: Obj[] = [];
  const better: Obj[] = [];
  const add = (bucket: Obj[], metric: string, before: unknown, after: unknown, change: unknown): void => {
    bucket.push({ metric, before, after, delta: change });
  };

  const successRate = delta.success_rate;
  if (isNumber(successRate) && Math.abs(successRate) >= SUCCESS_EPS) {
    add(successRate < 0 ? worse : better, "success_rate", previous.success_rate, current.success_rate, successRate);
  }
  const p95 = delta.p95_latency_ms;
  const p95Before = previous.p95_latency_ms;
  if (isNumber(p95) && isNumber(p95Before) && p95Before > 0 && Math.abs(p95) / Math.abs(p95Before) >= 0.1) {
    add(p95 > 0 ? worse : better, "p95_latency_ms", p95Before, current.p95_latency_ms, p95);
  }
  const cost = delta.cost_per_task;
  const costBefore = previous.cost_per_task;
  if (isNumber(cost) && isNumber(costBefore) && costBefore > 0 && Math.abs(cost) / Math.abs(costBefore) >= 0.1) {
    // Higher cost is worse.
    add(cost > 0 ? worse : better, "cost_per_task", costBefore, current.cost_per_task, cost);
  }
  return [worse, better];
}

function decide(
  run: Obj,
  metrics: Obj,
  delta: Obj | null,
  regressed: string[],
  improved: string[],
  rewardDrops: Obj[],
  nCommon: number,
  attribution: Obj,
  lang: Lang,
): Obj {
  const status = run.status;
  if (status !== "finished") {
    return verdict(
      "inconclusive",
      "low",
      "run_incomplete",
      msg(lang, "This run has not finished, so the conclusion is incomplete", "该轮次尚未收尾，结论不完整"),
      { status },
    );
  }
  if (!metrics.tasks) {
    return verdict(
      "inconclusive",
      "low",
      "no_outcomes",
      msg(lang, "This run has no task outcomes, so no conclusion can be drawn", "本轮没有任何任务结果，无法下结论"),
    );
  }
  if (attribution.changed === "benchmark" || stringsOf(attribution.keys).includes("benchmark")) {
    return verdict(
      "inconclusive",
      "low",
      "benchmark_changed",
      msg(
        lang,
        "The benchmark or its scope changed, so metrics are not directly comparable",
        "本轮评测集/范围发生变更，前后指标不可直接比较",
      ),
      {
        keys: attribution.keys,
      },
    );
  }
  if (delta === null) {
    if (run.parent_id) {
      return verdict(
        "inconclusive",
        "low",
        "parent_not_found",
        msg(lang, "The parent run could not be found, so delta cannot be computed", "找不到父轮次记录，无法计算 delta"),
        {
          parent_id: run.parent_id,
        },
      );
    }
    return verdict(
      "inconclusive",
      "low",
      "baseline_only",
      msg(lang, "No parent run to compare against; this run is recorded as a baseline", "无父轮次可对比，本轮仅作为基线记录"),
    );
  }

  const level = confidence(nCommon);
  // Verdict strength must match sample size: with only 1~2 common tasks, a single flip cannot veto a whole round.
  if ((regressed.length > 0 || improved.length > 0 || rewardDrops.length > 0) && nCommon < TASK_SAMPLE_MIN) {
    return verdict(
      "inconclusive",
      "low",
      "task_sample_too_small",
      msg(
        lang,
        `Only ${nCommon} common tasks; the task-level difference is not conclusive`,
        `共同任务仅 ${nCommon} 个，任务级差异不足以判定`,
      ),
      {
        common_tasks: nCommon,
        min_tasks: TASK_SAMPLE_MIN,
        regressed: regressed.slice(0, MAX_EVIDENCE_TASKS),
        improved: improved.slice(0, MAX_EVIDENCE_TASKS),
        reward_drops: rewardDrops.slice(0, MAX_EVIDENCE_TASKS),
      },
    );
  }
  if (regressed.length > 0 && improved.length === 0) {
    return verdict(
      "reject",
      level,
      "task_regression",
      msg(lang, `${regressed.length} tasks went from passing to failing`, `${regressed.length} 个任务从通过变为失败`),
      {
        tasks: regressed.slice(0, MAX_EVIDENCE_TASKS),
        parent_epoch: delta.parent_epoch,
      },
    );
  }
  if (improved.length > 0 && regressed.length === 0) {
    if (rewardDrops.length === 0) {
      return verdict(
        "accept",
        level,
        "task_improvement",
        msg(lang, `${improved.length} tasks went from failing to passing`, `${improved.length} 个任务从失败变为通过`),
        {
          tasks: improved.slice(0, MAX_EVIDENCE_TASKS),
          parent_epoch: delta.parent_epoch,
        },
      );
    }
    // Tasks improved, but some still passing tasks dropped clearly in reward.
    return verdict(
      "inconclusive",
      level,
      "mixed_quality",
      msg(
        lang,
        `${improved.length} tasks improved, but ${rewardDrops.length} tasks dropped clearly in reward`,
        `${improved.length} 个任务改进，但同时有 ${rewardDrops.length} 个任务 reward 明显下滑`,
      ),
      { improved: improved.slice(0, MAX_EVIDENCE_TASKS), reward_drops: rewardDrops.slice(0, MAX_EVIDENCE_TASKS) },
    );
  }
  if (regressed.length > 0 && improved.length > 0) {
    return verdict(
      "inconclusive",
      "low",
      "mixed_changes",
      msg(
        lang,
        `${regressed.length} tasks regressed and ${improved.length} improved; manual review is needed`,
        `既有 ${regressed.length} 个任务回退，也有 ${improved.length} 个任务改进，需人工判断`,
      ),
      { regressed: regressed.slice(0, MAX_EVIDENCE_TASKS), improved: improved.slice(0, MAX_EVIDENCE_TASKS) },
    );
  }
  if (rewardDrops.length > 0) {
    return verdict(
      "inconclusive",
      level,
      "reward_regression",
      msg(
        lang,
        `${rewardDrops.length} tasks still pass but dropped clearly in reward`,
        `${rewardDrops.length} 个任务通过状态未变，但 reward 明显下滑`,
      ),
      {
        tasks: rewardDrops.slice(0, MAX_EVIDENCE_TASKS),
        parent_epoch: delta.parent_epoch,
      },
    );
  }

  const [worse, better] = metricChanges(delta);
  const joinMetrics = (items: Obj[]): string =>
    items.map(item => String(item.metric)).join(lang === "zh" ? "、" : ", ");
  if (worse.length > 0 && better.length === 0) {
    return verdict(
      "reject",
      "high",
      "metric_regression",
      msg(lang, `Significant metric regression: ${joinMetrics(worse)}`, `显著指标回归：${joinMetrics(worse)}`),
      {
        changes: worse,
      },
    );
  }
  if (better.length > 0 && worse.length === 0) {
    return verdict(
      "accept",
      "high",
      "metric_improvement",
      msg(lang, `Significant metric improvement: ${joinMetrics(better)}`, `显著指标改进：${joinMetrics(better)}`),
      {
        changes: better,
      },
    );
  }
  if (worse.length > 0 && better.length > 0) {
    return verdict(
      "inconclusive",
      "low",
      "mixed_metrics",
      msg(lang, "Metrics moved in both directions; no single conclusion", "指标互有升降，无法给出单一结论"),
      {
        regressions: worse,
        improvements: better,
      },
    );
  }
  if (level === "low") {
    return verdict(
      "inconclusive",
      "low",
      "insufficient_samples",
      msg(
        lang,
        `The sample is too small to judge regression (${nCommon} comparable tasks)`,
        `样本量不足以判断回归（${nCommon} 个可比任务）`,
      ),
      {
        common_tasks: nCommon,
        min_tasks: MIN_TASKS,
      },
    );
  }
  return verdict(
    "accept",
    level,
    "no_regression",
    msg(lang, "No regression found; safe to proceed to the next round", "未发现回归，可以进入下一轮"),
    { common_tasks: nCommon },
  );
}

function taskSummary(outcomes: Obj[] | null | undefined): Obj {
  const list = outcomes ?? [];
  const failed = list.filter(outcome => !outcome.success);
  const errored = failed.filter(outcome => ERR_STATUS.has(String(outcome.status ?? "").toLowerCase()));
  const attempts = new Map<string, Set<string>>();
  for (const outcome of list) {
    const taskId = String(outcome.task_id ?? "undefined");
    const attemptId = String(outcome.attempt_id ?? outcome.task_id ?? "undefined");
    const seen = attempts.get(taskId) ?? new Set<string>();
    seen.add(attemptId);
    attempts.set(taskId, seen);
  }
  const maxAttempts = Math.max(0, ...[...attempts.values()].map(set => set.size));
  return {
    passed: list.length - failed.length,
    failed: failed.length,
    errored: errored.length,
    failures: failed.slice(0, MAX_EVIDENCE_TASKS).map(outcome => ({
      task_id: outcome.task_id,
      status: outcome.status,
      reward: outcome.reward,
    })),
    attempts_per_task: maxAttempts,
  };
}

/** Keep only the most severe signal per category so one root cause does not flood the list. */
function nextActions(signals: Obj[] | null | undefined): Obj[] {
  const seen = new Set<unknown>();
  const actions: Obj[] = [];
  for (const signal of signals ?? []) {
    const category = signal.category;
    if (seen.has(category)) continue;
    seen.add(category);
    actions.push({
      priority: signal.severity,
      target: signal.target,
      action: asObject(signal.suggestion).direction ?? signal.title,
      reason: signal.title,
      evidence: signal.evidence ?? {},
    });
    if (actions.length >= MAX_ACTIONS) break;
  }
  return actions;
}

function evidenceIndex(traces: Obj[] | null | undefined): Obj {
  const stepIds: string[] = [];
  const sessions = new Set<string>();
  for (const trace of traces ?? []) {
    if (trace.kind !== "trajectory") continue;
    const payload = asObject(trace.payload);
    const session = String(trace.session ?? payload.session_id ?? "");
    if (session) sessions.add(session);
    for (const step of listOf(payload.steps)) {
      if (step.step_id !== null && step.step_id !== undefined) stepIds.push(String(step.step_id));
    }
  }
  return { step_ids: stepIds.slice(0, MAX_STEP_IDS), sessions: [...sessions].sort() };
}

function metricsOf(pop: Obj | null | undefined, tokens: Obj | null): Obj {
  const record = asObject(pop);
  const tasks = Number(record.tasks ?? 0);
  const cost = record.cost_usd;
  return {
    tasks: record.tasks,
    success_rate: record.success_rate,
    reward_mean: record.reward_mean,
    p50_latency_ms: record.p50_latency_ms,
    p95_latency_ms: record.p95_latency_ms,
    cost_usd: cost,
    cost_per_task: isNumber(cost) && tasks ? round(cost / tasks, 6) : null,
    tokens,
    steps_mean: record.steps_mean,
    trajectories: record.trajectories,
  };
}

/**
 * Challenge the verdict: only contrast existing LLM findings / deterministic signals against it, never alter it.
 *
 * No extra LLM call on purpose: this runs on the main finish path and another round trip would slow
 * it down; the findings are already evidence-checked, so colliding them with the verdict still surfaces disagreement.
 */
function challenges(
  verdictObj: Obj,
  analysis: AnalysisLike | null,
  signals: Obj[] | null | undefined,
  nCommon: number,
  lang: Lang,
): Obj[] {
  const decision = verdictObj.decision;
  const code = asObject(listOf(verdictObj.reasons)[0]).code;
  const record = asObject(analysis);
  const findings = listOf(record.findings);
  const llmReady = record.source === "llm";
  const highFindings = findings.filter(finding => finding.severity === "high");
  const highSignals = (signals ?? []).filter(signal => signal.severity === "high");
  const out: Obj[] = [];
  const add = (text: string, basis: string, severity = "medium", ref: Obj = {}): void => {
    if (out.length < MAX_CHALLENGES) out.push({ text, basis, severity, ref });
  };

  if (decision === "accept") {
    for (const finding of highFindings.slice(0, 2)) {
      add(
        msg(
          lang,
          `Rules accepted the run, but the LLM analysis reports a high-severity issue: ${String(finding.title)}`,
          `规则判通过，但 LLM 归因指出 high 级问题：${String(finding.title)}`,
        ),
        "analysis",
        "high",
        asObject(finding.evidence),
      );
    }
    for (const signal of highSignals.slice(0, 1)) {
      add(
        msg(
          lang,
          `Rules accepted the run, but a high-severity deterministic signal fired: ${String(signal.title)}`,
          `规则判通过，但确定性信号中存在 high 级问题：${String(signal.title)}`,
        ),
        "signal",
        "high",
        { signal: signal.id },
      );
    }
    if (!llmReady) {
      add(
        msg(
          lang,
          "Rules accepted the run, but there is no LLM analysis to cross-check it",
          "规则判通过，但本轮没有 LLM 归因可交叉验证",
        ),
        "no_analysis",
        "low",
      );
    }
  } else if (decision === "reject") {
    if (llmReady && highFindings.length === 0 && findings.filter(finding => finding.severity === "medium").length === 0) {
      add(
        msg(
          lang,
          "Rules rejected the run, but the LLM found no medium or high quality issues; this may be statistical or environmental noise",
          "规则判拒绝，但 LLM 未发现中高等级质量问题，可能是统计波动或环境抖动",
        ),
        "analysis",
        "medium",
      );
    }
    if (code === "task_regression" && verdictObj.confidence === "low") {
      add(
        msg(
          lang,
          `Rejected based on only ${nCommon} common tasks; the sample cannot rule out single-task noise`,
          `仅基于 ${nCommon} 个共同任务判拒绝，样本不足以排除单任务波动`,
        ),
        "sample",
        "medium",
        { common_tasks: nCommon },
      );
    }
  } else if (decision === "inconclusive") {
    // "Inconclusive" may stem from small samples, a benchmark change, or a missing baseline;
    // if high-severity signals exist in absolute terms, the verdict understates severity, so only flag this mismatch.
    if (highSignals.length > 0) {
      add(
        msg(
          lang,
          `The verdict is inconclusive, but ${highSignals.length} high-severity signals fired; in absolute terms this is not acceptable: ${String(highSignals[0]?.title)}`,
          `判决为待定，但本轮有 ${highSignals.length} 个 high 级信号，绝对水平已不合格：${String(highSignals[0]?.title)}`,
        ),
        "signal",
        "high",
        { signals: highSignals.slice(0, 5).map(signal => signal.id) },
      );
    }
  }
  return out;
}

/** Build the conclusion object for one run; parent only needs {epoch, outcomes}. */
export function buildConclusion(
  epoch: string,
  run: Obj | null,
  population: Obj | null,
  signals: Obj[] | null,
  outcomes: Obj[] | null,
  traces: Obj[] | null = null,
  delta: Obj | null = null,
  parent: ParentRef | null = null,
  analysis: AnalysisLike | null = null,
  lang: Lang = "en",
): Obj {
  const runRecord = asObject(run);
  const metrics = metricsOf(population, tokenTotals(outcomes));
  const taskInfo = taskSummary(outcomes);
  const parentRecord = asObject(parent);
  let regressed: string[] = [];
  let improved: string[] = [];
  let rewardDrops: Obj[] = [];
  let nCommon = 0;
  if (parentRecord.outcomes !== null && parentRecord.outcomes !== undefined) {
    const current = taskMap(outcomes);
    const previous = taskMap(parentRecord.outcomes as Obj[]);
    nCommon = [...current.keys()].filter(key => previous.has(key)).length;
    [regressed, improved, rewardDrops] = taskDiff(current, previous);
  }
  const attribution = asObject(delta).attribution ?? {
    changed: "unknown",
    keys: [],
    unchanged: [],
    note: msg(lang, "No parent run to compare against, so attribution is unavailable", "无父轮次可对比，无法归因"),
  };
  const verdictObj = decide(
    runRecord,
    metrics,
    delta,
    regressed,
    improved,
    rewardDrops,
    nCommon,
    asObject(attribution),
    lang,
  );
  // Verdicts come only from rules; challenges merely flag that someone disagrees and never take part in the decision.
  verdictObj.decided_by = "rules";
  verdictObj.challenges = challenges(verdictObj, analysis, signals, nCommon, lang);
  let config: unknown = runRecord.config;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config) as unknown;
    } catch {
      config = null;
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    engine: {
      version: RULES_VERSION,
      rules_version: RULES_VERSION,
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    },
    epoch,
    run: {
      status: runRecord.status,
      candidate_id: runRecord.candidate_id,
      parent_id: runRecord.parent_id,
      config: isRecord(config) ? config : null,
    },
    verdict: verdictObj,
    metrics,
    task_summary: taskInfo,
    delta_vs_parent: delta,
    attribution,
    next_actions: nextActions(signals),
    signals: signals ?? [],
    analysis,
    evidence_index: evidenceIndex(traces),
    capabilities: {
      pass_at_k: (Number(taskInfo.attempts_per_task) || 0) <= 1 ? "unavailable" : "supported",
      attempts_per_task: taskInfo.attempts_per_task,
      note: msg(
        lang,
        "pass@k / flakiness needs multiple samples per task; each task currently has only one attempt",
        "pass@k / flakiness 需要同一任务多次采样，当前每个任务只有 1 个 attempt",
      ),
    },
  };
}

function num(value: unknown, digits = 2, suffix = ""): string {
  if (value === null || value === undefined) return "—";
  if (isNumber(value)) return `${value.toFixed(digits)}${suffix}`;
  return String(value);
}

/** Human-readable version: verdict first, then evidence, then next actions. */
export function conclusionMarkdown(conclusion: Obj, lang: Lang = "en"): string {
  const verdictObj = asObject(conclusion.verdict);
  const metrics = asObject(conclusion.metrics);
  const lines: string[] = [
    msg(lang, `# Evaluation conclusion · epoch ${String(conclusion.epoch)}`, `# 评测结论 · epoch ${String(conclusion.epoch)}`),
    "",
    msg(
      lang,
      `## ${DECISION_LABEL[lang][String(verdictObj.decision)] ?? String(verdictObj.decision)} (confidence: ${
        CONFIDENCE_LABEL[lang][String(verdictObj.confidence)] ?? String(verdictObj.confidence)
      })`,
      `## ${DECISION_LABEL[lang][String(verdictObj.decision)] ?? String(verdictObj.decision)}（置信度 ${
        CONFIDENCE_LABEL[lang][String(verdictObj.confidence)] ?? String(verdictObj.confidence)
      }）`,
    ),
    "",
  ];
  for (const reason of listOf(verdictObj.reasons)) {
    lines.push(msg(lang, `- ${String(reason.text)} (\`${String(reason.code)}\`)`, `- ${String(reason.text)}（\`${String(reason.code)}\`）`));
  }
  lines.push("");

  const challengeList = listOf(verdictObj.challenges);
  if (challengeList.length > 0) {
    lines.push(msg(lang, "### Challenges to the verdict (verdict unchanged)", "### 对判决的质疑（不改变判决）"), "");
    for (const challenge of challengeList) {
      lines.push(`- [${String(challenge.severity)}] ${String(challenge.text)}`);
    }
    lines.push("");
  }

  lines.push(
    msg(lang, "## Metrics", "## 指标"),
    "",
    msg(lang, "| Metric | Value |", "| 指标 | 值 |"),
    "| --- | --- |",
  );
  const tokens = asObject(metrics.tokens);
  const rows: Array<[string, unknown]> = [
    ["tasks", metrics.tasks],
    ["success_rate", num(metrics.success_rate, 4)],
    ["reward_mean", num(metrics.reward_mean, 4)],
    ["p50_latency_ms", num(metrics.p50_latency_ms, 0)],
    ["p95_latency_ms", num(metrics.p95_latency_ms, 0)],
    ["cost_per_task", num(metrics.cost_per_task, 4)],
    ["tokens", `${String(tokens.input ?? "—")} in / ${String(tokens.output ?? "—")} out`],
    ["steps_mean", num(metrics.steps_mean)],
  ];
  for (const [key, value] of rows) {
    lines.push(`| ${key} | ${value === null || value === undefined ? "—" : String(value)} |`);
  }
  lines.push("");

  const summary = asObject(conclusion.task_summary);
  lines.push(
    msg(lang, "## Tasks", "## 任务"),
    "",
    msg(
      lang,
      `- Passed ${String(summary.passed)} / failed ${String(summary.failed)} / errored ${String(summary.errored)}`,
      `- 通过 ${String(summary.passed)} / 失败 ${String(summary.failed)} / 报错 ${String(summary.errored)}`,
    ),
  );
  for (const failure of listOf(summary.failures)) {
    lines.push(
      msg(
        lang,
        `- Failed ${String(failure.task_id)} · status=${String(failure.status ?? "—")} · reward=${String(failure.reward)}`,
        `- 失败 ${String(failure.task_id)} · status=${String(failure.status ?? "—")} · reward=${String(failure.reward)}`,
      ),
    );
  }
  lines.push("");

  const delta = asObject(conclusion.delta_vs_parent);
  if (Object.keys(delta).length > 0) {
    const changes: string[] = [];
    const fields: Array<[string, string, number]> = [
      ["success_rate", "pp", 1],
      ["p50_latency_ms", " ms", 0],
      ["p95_latency_ms", " ms", 0],
      ["cost_per_task", "", 4],
      ["steps_mean", "", 2],
    ];
    for (const [key, unit, digits] of fields) {
      let value = delta[key];
      if (value === null || value === undefined) continue;
      if (key === "success_rate") value = Number(value) * 100;
      changes.push(`${key} ${signedFixed(Number(value), digits)}${unit}`);
    }
    lines.push(
      msg(lang, `## Versus parent ${String(delta.parent_epoch)}`, `## 对比父轮次 ${String(delta.parent_epoch)}`),
      "",
      msg(
        lang,
        `- ${changes.length > 0 ? changes.join(", ") : "Core metrics unchanged"}`,
        `- ${changes.length > 0 ? changes.join("，") : "核心指标无变化"}`,
      ),
      msg(
        lang,
        `- Significance: ${delta.significant ? "significant" : "not significant"}`,
        `- 显著性：${delta.significant ? "显著" : "不显著"}`,
      ),
    );
    const diffCi = asObject(delta.success_rate_ci).diff;
    if (Array.isArray(diffCi)) {
      lines.push(
        msg(
          lang,
          `- Success-rate change 95% CI [${signedFixed(Number(diffCi[0]) * 100, 1)}pp, ${signedFixed(Number(diffCi[1]) * 100, 1)}pp]${
            Number(diffCi[0]) <= 0 && Number(diffCi[1]) >= 0 ? ", crossing 0 means noise" : ""
          }`,
          `- 成功率变化 95% 区间 [${signedFixed(Number(diffCi[0]) * 100, 1)}pp, ${signedFixed(Number(diffCi[1]) * 100, 1)}pp]${
            Number(diffCi[0]) <= 0 && Number(diffCi[1]) >= 0 ? "，跨 0 视为噪声" : ""
          }`,
        ),
      );
    }
    const attribution = asObject(conclusion.attribution);
    lines.push(
      msg(
        lang,
        `- Attribution: ${String(attribution.changed ?? "unknown")} ${String(attribution.note ?? "")}`,
        `- 归因：${String(attribution.changed ?? "未知")} ${String(attribution.note ?? "")}`,
      ),
    );
    lines.push("");
  } else if (conclusion.attribution) {
    lines.push(
      msg(lang, "## Attribution", "## 归因"),
      "",
      msg(
        lang,
        `- ${String(asObject(conclusion.attribution).note ?? "No parent run to compare against")}`,
        `- ${String(asObject(conclusion.attribution).note ?? "无父轮次可对比")}`,
      ),
      "",
    );
  }

  const actions = listOf(conclusion.next_actions);
  lines.push(msg(lang, "## Next actions", "## 下一步动作"), "");
  if (actions.length === 0) lines.push(msg(lang, "- Nothing to do", "- 无需处理"));
  for (const action of actions) {
    lines.push(
      `- [${String(action.priority)}] ${String(action.target)}${lang === "zh" ? "：" : ": "}${String(action.action)}`,
    );
  }
  lines.push("");

  const signalList = listOf(conclusion.signals);
  lines.push(
    msg(
      lang,
      `## Deterministic signals (${signalList.length})`,
      `## 确定性信号（${signalList.length} 条）`,
    ),
    "",
  );
  for (const signal of signalList) {
    lines.push(`- [${String(signal.severity)}] ${String(signal.target)} / ${String(signal.category)} · ${String(signal.title)}`);
  }
  if (signalList.length > 0) lines.push("");

  const analysis = asObject(conclusion.analysis);
  if (analysis.source === "llm") {
    lines.push(
      msg(lang, `## LLM analysis (${String(analysis.model)})`, `## LLM 归因（${String(analysis.model)}）`),
      "",
      String(analysis.summary ?? ""),
    );
    for (const finding of listOf(analysis.findings)) {
      lines.push(
        `- [${String(finding.severity)}] ${String(finding.title)}${lang === "zh" ? "：" : ": "}${String(finding.recommendation ?? "")}`,
      );
    }
  } else {
    lines.push(
      msg(lang, "## LLM analysis", "## LLM 归因"),
      "",
      msg(
        lang,
        `- Not enabled (${analysis.source === "rules" ? "rule fallback" : "no provider configured"})`,
        `- 未启用（${analysis.source === "rules" ? "规则回退" : "未配置 provider"}）`,
      ),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function signedFixed(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}
