import { fixtureFailure } from "../fixtures/results/store-fixture.js";
import { expect, test } from "vitest";
import { computeSuccessRate } from "../../src/plugins/metrics/success-rate.js";
import { computeDuration } from "../../src/plugins/metrics/duration.js";
import { computeUsage } from "../../src/plugins/metrics/usage.js";
import { HarborScoreMetrics } from "../../src/plugins/metrics/harbor-score.js";
const harborScore = new HarborScoreMetrics({ dimensions: [] });
import { aggregateMetrics } from "../../src/plugins/metrics/aggregate.js";
import { renderMarkdown } from "../../src/plugins/reporters/markdown.js";
import { mixedSnapshot } from "../fixtures/results/mixed-run/fixture.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { classifyError } from "../../src/core/errors/classify.js";
import { finalizeAttemptOutcome } from "../../src/core/results/evaluation-outcome.js";
import type { PreparationRound } from "../../src/core/contracts/result.js";

function preparationRound(id: string, startedAt = "2026-09-18T00:00:00.000Z"): PreparationRound {
  return {
    id, taskIds: ["pass"], policy: { version: "fixture", source: "fixture" }, budgetSeconds: 60,
    startedAt, deadlineAt: "2026-09-18T00:01:00.000Z", finishedAt: "2026-09-18T00:00:10.000Z", status: "ready",
    tasks: [{ taskId: "pass", status: "ready", queuedAt: startedAt, startedAt,
      finishedAt: "2026-09-18T00:00:10.000Z", queueDurationMs: 20, durationMs: 7000,
      phaseDurationMs: { solveEnvironment: 6000, verifyEnvironment: 1000 } }],
  };
}

test("scored cleanup failure remains in the denominator and reports its separate resource failure", () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.records = snapshot.records.slice(0, 1);
  snapshot.run.taskIds = ["pass"];
  snapshot.pendingTaskIds = [];
  snapshot.run.status = "error";
  const record = snapshot.records[0]!;
  record.errors = [classifyError(new DOMException("cleanup deadline", "TimeoutError"), { phase: "cleanup" })];
  finalizeAttemptOutcome(record);
  expect(computeSuccessRate(snapshot)).toMatchObject({ denominator: 1, invalid: 0, passed: 1, rate: 1 });
  const report = renderMarkdown(snapshot, {});
  expect(report).toContain("| pass | completed | 1 |");
  expect(report).toContain("CLEANUP_TIMEOUT");
  expect(report).toContain("| 清理未确认 | 1 |");
});

test("markdown exposes nonfatal transfer warnings without changing metrics or claiming complete evidence", () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.records = snapshot.records.slice(0, 1); snapshot.run.taskIds = ["pass"];
  snapshot.pendingTaskIds = []; snapshot.run.status = "completed";
  const expected = computeSuccessRate(snapshot);
  Object.assign(snapshot.records[0]!, { warnings: [{ phase: "transfer", code: "TRANSFER_UNSAFE", message: '/app/venv/bin/python3 -> /usr/bin/python3 (absolute-target) <script>|[link](bad)' }] });
  const report = renderMarkdown(snapshot, {});
  expect(report).toContain("警告"); expect(report).toContain("/app/venv/bin/python3");
  expect(report).toContain("/usr/bin/python3"); expect(report).toContain("absolute-target");
  expect(report).not.toContain("<script>"); expect(report).not.toContain("[link](bad)");
  expect(report).not.toContain("运行与证据完整");
  expect(computeSuccessRate(snapshot)).toEqual(expected);
});

test("markdown distinguishes affected tasks from repeated errors and preserves historical timeout evidence", () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.records = snapshot.records.slice(0, 1);
  snapshot.run.taskIds = ["pass"]; snapshot.pendingTaskIds = []; snapshot.run.status = "completed";
  const record = snapshot.records[0]!;
  record.executionStatus = "agent_timeout";
  record.phaseDurationMs.solve = 1234;
  record.solve = null; record.verdict = null;
  record.collection = { trajectory: "partial", artifacts: "complete" };
  record.errors = [
    fixtureFailure("solve", "SOLVER_AGENT_TIMEOUT", "Task deadline exceeded"),
    fixtureFailure("collect", "ARTIFACT_COLLECTION_INCOMPLETE", "Task evidence is missing or partial"),
    fixtureFailure("collect", "ARTIFACT_COLLECTION_INCOMPLETE", "Independent artifact export failed"),
    fixtureFailure("cleanup", "CLEANUP_FAILED", "Container cleanup failed"),
  ];
  finalizeAttemptOutcome(record);
  const before = structuredClone(snapshot);
  const report = renderMarkdown(snapshot, {});
  expect(report).toContain("异常任务 1；错误记录 4（主流程 1；证据收集 2；资源清理 1）");
  expect(report).toContain("| solve | SOLVER_AGENT_TIMEOUT | 1 | 1 |");
  expect(report).toContain("| collect | ARTIFACT_COLLECTION_INCOMPLETE | 1 | 2 |");
  expect(report).toContain("| cleanup | CLEANUP_FAILED | 1 | 1 |");
  expect(report).toContain("| pass | timeout (agent) | 0 | 1.23 |");
  const taskRows = report.split("## Tasks")[1]?.split("\n## ")[0] ?? "";
  expect(taskRows).not.toContain("Task deadline exceeded");
  expect(taskRows).not.toContain("Task evidence is missing or partial");
  expect(taskRows.match(/ARTIFACT\\_COLLECTION\\_INCOMPLETE/gu)).toHaveLength(1);
  expect(snapshot).toEqual(before);
});

test("success denominator excludes explicit invalid attempts and retains pending tasks", () => {
  expect(computeSuccessRate(mixedSnapshot)).toEqual({ selected: 4, denominator: 3, invalid: 1, passed: 1, rate: 1 / 3, verified: 2, pending: 1 });
  const unsupported = structuredClone(mixedSnapshot); unsupported.records[2]!.executionStatus = "failed";
  expect(computeSuccessRate(unsupported)).toEqual(computeSuccessRate(mixedSnapshot));
});

test("WorkBuddy reward averages partial scores and counts missing attempts as zero", async () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.records[1]!.verdict = { score: 0.5, passed: false, details: { testStatus: "partial_pass" } };
  const metric = await harborScore.compute(snapshot);
  expect(metric).toMatchObject({ selected: 4, denominator: 3, invalid: 1, verified: 2, passed: 1, meanReward: 0.5 });
  const rebuilt = await aggregateMetrics(snapshot, [harborScore]);
  expect(renderMarkdown(snapshot, rebuilt)).toContain("| 平均奖励 | 0.5 |");
  snapshot.records[0]!.executionStatus = "cancelled"; snapshot.records[0]!.scoreStatus = "invalid";
  expect(await harborScore.compute(snapshot)).toMatchObject({ verified: 1, passed: 0, meanReward: 0.25 });
});

test("a run with pass, wrong, error, unsupported and pending preserves all five statuses", () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.run.taskIds.push("unsupported");
  snapshot.records.push({ ...structuredClone(snapshot.records[2]!), key: { runId: snapshot.run.runId, taskId: "unsupported", attemptId: "a4" }, executionStatus: "failed", scoreStatus: "invalid", errors: [fixtureFailure("prepare", "BENCHMARK_UNSUPPORTED", "unsupported")] });
  const metrics = computeSuccessRate(snapshot);
  expect(metrics).toEqual({ selected: 5, denominator: 3, invalid: 2, passed: 1, rate: 1 / 3, verified: 2, pending: 1 });
  const report = renderMarkdown(snapshot, { "success-rate": metrics });
  expect(report).toContain("执行失败 2"); expect(report).toContain("不支持 1"); expect(report).toContain("待运行 1");
});

test("empty statistics are unknown rather than manufactured zeros", () => {
  const empty = structuredClone(mixedSnapshot); empty.run.taskIds = []; empty.records = []; empty.pendingTaskIds = [];
  expect(computeSuccessRate(empty)).toEqual({ selected: 0, denominator: 0, invalid: 0, passed: 0, rate: null, verified: 0, pending: 0 });
  expect(computeDuration(empty).tasks).toEqual({ count: 0, minMs: null, maxMs: null, meanMs: null });
  expect(computeUsage(empty).inputTokens).toEqual({ total: null, covered: 0 });
  expect(renderMarkdown(empty, {})).toContain("有效评分覆盖率：0/0（未知）");
});

test("markdown coverage distinguishes scored wrong answers from invalid and pending tasks", () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.records[2]!.scoreStatus = "invalid";
  const report = renderMarkdown(snapshot, {});
  expect(report).toContain("有效评分覆盖率：2/4（50.00%）");
  expect(report).toContain("| wrong | completed | 0 |");
});

test("a valid score survives a later cleanup failure but cancelled attempts are not scored", () => {
  const changed = structuredClone(mixedSnapshot);
  changed.records[0]!.errors = [fixtureFailure("cleanup", "CLEANUP_FAILED", "cleanup failed")];
  finalizeAttemptOutcome(changed.records[0]!);
  expect(computeSuccessRate(changed).passed).toBe(1);
  changed.records[0]!.executionStatus = "cancelled"; changed.records[0]!.scoreStatus = "invalid"; changed.pendingTaskIds.push("pass");
  expect(computeSuccessRate(changed)).toMatchObject({ passed: 0, verified: 1, pending: 2 });
});

test("wall time is separate from task and phase distributions", () => {
  const duration = computeDuration(mixedSnapshot);
  expect(duration.runWallTimeMs).toBe(100);
  expect(duration.tasks).toEqual({ count: 3, minMs: 20, maxMs: 100, meanMs: 160 / 3 });
  expect(duration.phases.solve).toEqual({ count: 2, minMs: 30, maxMs: 80, meanMs: 55 });
});

test("task rows display solve and verify seconds, preserve zero and leave missing or pending durations unknown", () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.records[1]!.phaseDurationMs.solve = 0;
  snapshot.records[1]!.phaseDurationMs.verify = 0;
  const report = renderMarkdown(snapshot, {});
  expect(report).toContain("| 任务 | 状态 | 评分 | 解题用时（秒） | 验证用时（秒） | 轨迹 / 产物 | 错误 | 证据 |");
  expect(report).toContain("| pass | completed | 1 | 0.08 | 0.01 |");
  expect(report).toContain("| wrong | completed | 0 | 0.00 | 0.00 |");
  expect(report).toContain("| error | invalid | — | — | — |");
  expect(report).toContain("| pending | pending | — | — | — | — | — | — |");
  expect(report).toContain(`[文件清单](tasks/${safeTaskKey("pass")}/attempts/a1/files.json)`);
  let columns: number | undefined;
  for (const line of report.split("\n")) {
    if (!line.startsWith("|")) { columns = undefined; continue; }
    const cells = line.split("|").length;
    if (columns === undefined) columns = cells;
    expect(cells).toBe(columns);
  }
});

test("markdown shows aggregate preparation timing without rounds or attempt details", () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.run.preparationRounds = [preparationRound("first"), preparationRound("retry", "2026-09-18T00:00:01.000Z")];
  const report = renderMarkdown(snapshot, { duration: computeDuration(snapshot) });
  expect(report).toContain("| 环境准备耗时 | 9 秒 |");
  expect(report).toContain("| 解题 |");
  expect(report).not.toContain("轮次");
  expect(report).not.toContain("first");
  expect(report).not.toContain("retry");
  expect(report).not.toContain("历史 attempts");
  expect(renderMarkdown(mixedSnapshot, { duration: computeDuration(mixedSnapshot) })).not.toContain("环境准备耗时");
});

test("new preparation policies report actual capped environment budgets without inventing historical values", () => {
  const snapshot = structuredClone(mixedSnapshot);
  const round = preparationRound("current");
  round.timeoutPolicy = "task-concurrency-v1";
  round.budgetSeconds = null;
  round.deadlineAt = null;
  for (const task of round.tasks ?? []) task.environmentTimeouts = { solve: {
    baseSeconds: 600, concurrency: 32, multiplier: 10, timeoutSeconds: 6000,
    startedAt: round.startedAt, deadlineAt: "2026-09-18T01:40:00.000Z", finishedAt: round.finishedAt,
  } };
  snapshot.run.preparationRounds = [round];
  const report = renderMarkdown(snapshot, { duration: computeDuration(snapshot) });
  expect(report).toContain("实际环境时限（秒）");
  expect(report).toContain("| current | 未设置 | 600 | 32 | 10 | 6000 |");
});

test("usage preserves field-specific coverage and does not infer missing totals", () => {
  expect(computeUsage(mixedSnapshot)).toEqual({
    selected: 4, recorded: 3,
    inputTokens: { total: 5, covered: 1 }, outputTokens: { total: 5, covered: 2 }, totalTokens: { total: 7, covered: 1 },
  });
  const unknown = structuredClone(mixedSnapshot); for (const record of unknown.records) record.solve = null;
  expect(computeUsage(unknown).totalTokens).toEqual({ total: null, covered: 0 });
});

test("duplicate or foreign records cannot inflate aggregate scores", () => {
  const duplicate = structuredClone(mixedSnapshot); duplicate.records.push(duplicate.records[0]!);
  expect(() => computeSuccessRate(duplicate)).toThrow(/duplicate/i);
  const foreign = structuredClone(mixedSnapshot); foreign.records[0]!.key.taskId = "foreign";
  expect(() => computeUsage(foreign)).toThrow(/selected/i);
});

test("duplicate metric names fail before any plugin runs", async () => {
  let calls = 0; const plugin = { name: "duplicate", async compute() { calls++; return null; } };
  await expect(aggregateMetrics(mixedSnapshot, [plugin, plugin])).rejects.toThrow(/duplicate/i);
  expect(calls).toBe(0);
});

test("each metric sees the same snapshot even if another plugin mutates its input", async () => {
  const metrics = await aggregateMetrics(mixedSnapshot, [
    { name: "mutates", async compute(snapshot) { snapshot.run.taskIds.length = 0; return null; } },
    { name: "count", async compute(snapshot) { return snapshot.run.taskIds.length; } },
  ]);
  expect(metrics.count).toBe(4); expect(mixedSnapshot.run.taskIds).toHaveLength(4);
});

test("markdown shows incompleteness, snapshot identity and safe relative evidence links", () => {
  const malicious = structuredClone(mixedSnapshot);
  const taskId = "[click](file:///secret)|<script>\nnext";
  malicious.run.taskIds[0] = taskId; malicious.records[0]!.key.taskId = taskId;
  const markdown = renderMarkdown(malicious, { "success-rate": computeSuccessRate(malicious) });
  expect(markdown).toContain("未完成"); expect(markdown).toContain("locked");
  expect(markdown).toContain(`tasks/${safeTaskKey(taskId)}/attempts/a1/result.json`);
  expect(markdown).not.toContain("[click]("); expect(markdown).not.toContain("<script>");
  expect(markdown).toContain("ENV\\_PREPARATION\\_FAILED");
  expect(markdown).not.toContain("fixture failure");
});

test("markdown includes a useful redacted configuration summary", () => {
  const snapshot = structuredClone(mixedSnapshot);
  Object.assign(snapshot.run, { configSummary: { model: { name: "actual-model", apiKey: "NEVER_PRINT" }, benchmark: "gsm8k", solver: "simpleagent", scheduler: "local" } });
  const markdown = renderMarkdown(snapshot, {});
  expect(markdown).toContain("actual-model"); expect(markdown).toContain("gsm8k"); expect(markdown).toContain("simpleagent");
  expect(markdown).not.toContain("NEVER_PRINT");
});

test("score-free verdicts keep correctness metrics and leave reward unknown rather than zero", async () => {
  const snapshot = structuredClone(mixedSnapshot);
  for (const record of snapshot.records) if (record.verdict) delete record.verdict.score;
  expect(computeSuccessRate(snapshot)).toEqual(computeSuccessRate(mixedSnapshot));
  expect(await harborScore.compute(snapshot)).toMatchObject({ selected: 4, denominator: 3, invalid: 1, verified: 2, meanReward: null });
  const report = renderMarkdown(snapshot, { "success-rate": computeSuccessRate(snapshot) });
  expect(report).toContain("| pass | completed | — |"); expect(report).toContain("| wrong | completed | — |");
  const mixed = structuredClone(mixedSnapshot); delete mixed.records[1]!.verdict!.score;
  expect(await harborScore.compute(mixed)).toMatchObject({ verified: 2, meanReward: null });
});


test("Harbor reward dimensions use the run denominator and preserve missing dimensions as unknown", async () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.records[0]!.verdict!.details = { rewards: { f2p: 1, p2p: 1 } };
  snapshot.records[1]!.verdict!.details = { rewards: { f2p: 0.5 } };
  const metric = new HarborScoreMetrics({ dimensions: ["f2p", "p2p", "missing"] });
  expect(await metric.compute(snapshot)).toMatchObject({ denominator: 3, dimensions: { f2p: 0.5, p2p: null, missing: null } });
});

test("overview excludes a retained verdict from an invalid result", () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.records[0]!.scoreStatus = "invalid";
  snapshot.records[0]!.executionStatus = "cancelled";
  const report = renderMarkdown(snapshot, { "success-rate": computeSuccessRate(snapshot) });
  expect(report).toContain("| 答对 / 答错 / 解题超时 | 0 / 1 / 0 |");
});
