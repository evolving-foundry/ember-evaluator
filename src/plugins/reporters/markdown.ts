import type { Reporter, ReportContext, TaskReportTarget } from "../../core/contracts/reporter.js";
import type { MetricResults } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import { safeTaskKey } from "../../core/artifacts/artifacts.js";
import { redactSecrets } from "../../config/redact.js";
import { selectedRecords } from "../metrics/records.js";
import { attemptStatus, attemptTimeoutKind, evaluationScore, isAgentTimeout, isEvaluationComplete, isInvalidEvaluation, hasUnconfirmedCleanup } from "../../core/results/evaluation-outcome.js";
import { renderAgentXTables } from "./agentx-tables.js";
import { renderKernelTables } from "./kernel-tables.js";
import { expectRecord } from "../../core/validation/input.js";
import { parseAgentXSummary } from "../benchmarks/inference-engine/agentx/evidence/summary.js";
import { escaped, readableDuration, renderMetrics } from "./fields.js";

export function renderMarkdown(snapshot: ResultSnapshot, metrics: MetricResults, evidenceRoot = ""): string {
  const records = selectedRecords(snapshot);
  const performance = snapshot.run.evaluationKind === "performance";
  const byTask = new Map(records.map(record => [record.key.taskId, record]));
  const valid = records.filter(isEvaluationComplete).length;
  const coverage = snapshot.run.taskIds.length ? `${(valid / snapshot.run.taskIds.length * 100).toFixed(2)}%` : "未知";
  const warnings = records.flatMap(record => (record.warnings ?? []).map(warning => ({ taskId: record.key.taskId, warning })));
  const incomplete = snapshot.run.status !== "completed" || snapshot.pendingTaskIds.length > 0 || records.some(record => !isEvaluationComplete(record));
  const incompleteEvidence = records.some(record => [record.collection.trajectory, record.collection.artifacts].some(state => state === "missing" || state === "partial"));
  let summary = performance ? "性能测量已完成。" : "评测已完成。";
  if (incomplete) summary = "**未完成：本报告包含部分运行结果。**";
  else if (incompleteEvidence) summary = "评测已完成；部分证据不完整。";
  else if (warnings.length) summary = "运行已完成，存在警告。";
  const configuration = snapshot.run.configSummary === undefined ? undefined : redactSecrets(snapshot.run.configSummary);
  const configField = (name: string) => {
    const value = configuration && typeof configuration === "object" && !Array.isArray(configuration) ? configuration[name] : undefined;
    if (value === undefined || value === null) return "未记录";
    if (typeof value === "object" && !Array.isArray(value)) return typeof value.name === "string" ? escaped(value.name) : "未记录";
    return escaped(String(value));
  };
  const success = metrics["success-rate"];
  const score = success && typeof success === "object" && !Array.isArray(success) ? success : undefined;
  const lines = ["# Evaluator report", "", summary, "",
    ...(typeof score?.rate === "number" ? [`**正确率 ${(score.rate * 100).toFixed(2)}%（${score.passed}/${score.denominator}）**`, ""] : []),
    `Run: ${escaped(snapshot.run.runId)} · Status: ${escaped(snapshot.run.status)}`, "",
    "## 运行概况", "", "| 项目 | 结果 |", "| --- | --- |",
    `| Benchmark | ${configField("benchmark")} |`, `| 模型 | ${configField("model")} |`,
    `| Agent Harness | ${configField("solver")} |`, `| 环境 / 调度器 | ${configField("environment")} / ${configField("scheduler")} |`,
    `| 开始 / 结束（UTC） | ${escaped(snapshot.run.startedAt)} / ${escaped(snapshot.run.finishedAt ?? "未结束")} |`,
    `| 总耗时 | ${snapshot.run.durationMs == null ? "—" : readableDuration(snapshot.run.durationMs)} |`,
    ...(performance ? [] : [`| 答对 / 答错 / 解题超时 | ${records.filter(record => isEvaluationComplete(record) && record.verdict?.passed === true).length} / ${records.filter(record => isEvaluationComplete(record) && record.executionStatus === "completed" && record.verdict?.passed === false).length} / ${records.filter(isAgentTimeout).length} |`]),
    `| 清理未确认 | ${records.filter(hasUnconfirmedCleanup).length} |`,
    `| 轨迹不完整 / 产物不完整 | ${records.filter(record => ["partial", "missing"].includes(record.collection.trajectory)).length} / ${records.filter(record => ["partial", "missing"].includes(record.collection.artifacts)).length} |`, "",
    snapshot.run.source ? `已选择 ${snapshot.run.taskIds.length} ${performance ? "个测量点" : "题"}；已保存 ${records.length} 条记录；待运行 ${snapshot.pendingTaskIds.length} 题。` : "来源准备尚未完成，任务集合未确定。",
    snapshot.run.source ? `有效${performance ? "测量" : "评分"}覆盖率：${valid}/${snapshot.run.taskIds.length}（${coverage}）。` : "覆盖率未知。",
    `执行失败 ${records.filter(record => record.executionStatus === "failed").length}；超时 ${records.filter(record => attemptStatus(record) === "timeout").length}；取消 ${records.filter(record => record.executionStatus === "cancelled").length}；不支持 ${records.filter(record => attemptStatus(record) === "unsupported").length}。`,
    ...(performance ? [] : [`Agent 解题超时 ${records.filter(isAgentTimeout).length}（计 0 分）；无效 ${records.filter(isInvalidEvaluation).length}。`]), "",
    ...(snapshot.run.failure ? [`运行错误：${escaped(snapshot.run.failure.code)} ${escaped(snapshot.run.failure.message)}`, ""] : []),
    ...renderMetrics(metrics), ...renderAgentXTables(metrics["agentx-performance"]),
    ...renderKernelTables(metrics["kernel"], evidenceRoot),
    "## Tasks", "",
    `| 任务 | 状态 | ${performance ? "评分（不适用）" : "评分"} | ${performance ? "测量" : "解题"}用时（秒） | 验证用时（秒） | 轨迹 / 产物 | 错误 | 证据 |`,
    "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const id of snapshot.run.taskIds) {
    const record = byTask.get(id);
    if (!record) { lines.push(`| ${escaped(id)} | pending | — | — | — | — | — | — |`); continue; }
    const safe = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(record.key.attemptId) && !record.key.attemptId.endsWith(".");
    const root = `${evidenceRoot}tasks/${safeTaskKey(id)}/attempts/${record.key.attemptId}/`;
    const evidence = safe ? `[result](${root}result.json) · [文件清单](${root}files.json)${record.trajectory ? ` · [轨迹](${root}agent/trajectory.jsonl)` : ""}` : "无有效证据路径";
    const errors = [...new Set(record.errors.map(error => error.code))].join("; ");
    lines.push(`| ${escaped(id)} | ${attemptStatus(record)}${attemptTimeoutKind(record) ? ` (${attemptTimeoutKind(record)})` : ""} | ${evaluationScore(record) ?? "—"} | ${record.phaseDurationMs.solve === undefined ? "—" : (record.phaseDurationMs.solve / 1000).toFixed(2)} | ${record.phaseDurationMs.verify === undefined ? "—" : (record.phaseDurationMs.verify / 1000).toFixed(2)} | ${record.collection.trajectory} / ${record.collection.artifacts} | ${escaped(errors) || "—"} | ${evidence} |`);
  }
  const fallbackScores = records.flatMap(record => {
    const details = record.verdict?.details;
    return details && typeof details === "object" && !Array.isArray(details) && details.scoring === "submission-failure-zero"
      ? [{ record, details }] : [];
  });
  if (fallbackScores.length) {
    lines.push("", "## 提交错误计零分", "",
      "以下任务的评分脚本在读取或检查提交时失败。Evaluator 按失败处理规则计 0 分并纳入指标分母；这不是上游正常完成评分返回的原生分数。原始状态与奖励保存在各任务 result.json 的 verdict.details 中。", "",
      "| 任务 | 原始诊断 |", "| --- | --- |");
    for (const { record, details } of fallbackScores) {
      const evidence = details.evidence;
      const evaluator = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence.evaluator : null;
      const reason = evaluator && typeof evaluator === "object" && !Array.isArray(evaluator) ? evaluator.reason : null;
      lines.push(`| ${escaped(record.key.taskId)} | ${escaped(typeof reason === "string" ? reason : "参见任务评分证据")} |`);
    }
  }
  const failures = records.flatMap(record => record.errors.map(error => ({ taskId: record.key.taskId, error })));
  if (failures.length) {
    const counts = new Map<string, { phase: string; code: string; tasks: Set<string>; count: number }>();
    for (const { taskId, error } of failures) {
      const key = `${error.phase}/${error.code}`, entry = counts.get(key);
      if (entry) { entry.count++; entry.tasks.add(taskId); }
      else counts.set(key, { phase: error.phase, code: error.code, tasks: new Set([taskId]), count: 1 });
    }
    const collected = failures.filter(({ error }) => error.phase === "collect").length;
    const cleaned = failures.filter(({ error }) => error.phase === "cleanup").length;
    lines.push("", "## 错误分类与处理", "",
      `异常任务 ${records.filter(record => record.errors.length).length}；错误记录 ${failures.length}（主流程 ${failures.length - collected - cleaned}；证据收集 ${collected}；资源清理 ${cleaned}）。`, "",
      "| 阶段 | 错误码 | 涉及任务数 | 记录数 |", "| --- | --- | --- | --- |");
    for (const entry of counts.values()) lines.push(`| ${entry.phase} | ${entry.code} | ${entry.tasks.size} | ${entry.count} |`);
  }
  if (warnings.length) {
    lines.push("", "## 警告", "", `警告涉及 ${new Set(warnings.map(({ taskId }) => taskId)).size} 个任务，共 ${warnings.length} 条记录。`, "",
      "| 任务 | 阶段 / 代码 | 说明 |", "| --- | --- | --- |");
    for (const { taskId, warning } of warnings) lines.push(`| ${escaped(taskId)} | ${escaped(warning.phase)} / ${escaped(warning.code)} | ${escaped(warning.message)} |`);
  }
  if (snapshot.run.remoteAttempts?.length) {
    lines.push("", "## Remote collection", "", "| 任务 | 节点 / 主机 | 收集状态 | 说明 |", "| --- | --- | --- | --- |");
    for (const item of snapshot.run.remoteAttempts.filter(item => byTask.get(item.key.taskId)?.key.attemptId === item.key.attemptId))
      lines.push(`| ${escaped(item.key.taskId)} | ${escaped(item.nodeId ?? "unknown")} / ${escaped(item.hostname ?? "unknown")} | ${item.state} | ${escaped(item.message ?? "—")} |`);
  }
  lines.push("", "## 运行文件", "",
    `[指标 JSON](metrics.json) · [运行清单](${evidenceRoot}manifest.json) · [保存配置](${evidenceRoot}config.yaml)`,
    ...(snapshot.run.source ? ["", `数据来源：${escaped(snapshot.run.source.source)} @ ${escaped(snapshot.run.source.revision)}`] : []));
  return lines.join("\n") + "\n";
}

export class MarkdownReporter implements Reporter {
  taskReports(snapshot: ResultSnapshot, metrics: MetricResults): TaskReportTarget[] {
    const value = metrics["agentx-performance"];
    if (snapshot.run.taskIds.length < 2 || value === undefined) return [];
    const metric = expectRecord(value, "agentx-performance metric");
    if (metric.applicable !== true) return [];
    if (!Array.isArray(metric.points)) throw new TypeError("Invalid AgentX report points");
    const points = metric.points.map(value => expectRecord(value, "AgentX report point"));
    return snapshot.run.taskIds.map(taskId => {
      const point = points.find(point => point.taskId === taskId);
      const summary = point?.measurement == null ? null : parseAgentXSummary(point.measurement);
      const concurrency = summary?.workload.concurrency ?? /-c([1-9]\d*)$/u.exec(taskId)?.[1];
      return { taskId, id: concurrency === undefined ? `task-${safeTaskKey(taskId)}` : `c${concurrency}`,
        title: concurrency === undefined ? taskId : `AgentX c${concurrency}` };
    });
  }

  async render(snapshot: ResultSnapshot, metrics: MetricResults, context?: ReportContext) {
    const targets = context ? [] : this.taskReports(snapshot, metrics);
    if (!targets.length) return renderMarkdown(snapshot, metrics, context?.evidenceRoot);
    const records = new Map(selectedRecords(snapshot).map(record => [record.key.taskId, record]));
    return ["# AgentX 评测报告目录", "",
      `Run: ${escaped(snapshot.run.runId)} · Status: ${escaped(snapshot.run.status)}`,
      "",
      "各并发档位的性能、遥测、耗时和用量分别保存在独立报告中。本页仅列出整批状态及报告入口。", "",
      ...(snapshot.run.failure ? [`运行错误：${escaped(snapshot.run.failure.code)} ${escaped(snapshot.run.failure.message)}`, ""] : []),
      "| 测量点 | 状态 | 报告 | 指标 |", "| --- | --- | --- | --- |",
      ...targets.map(target => {
        const record = records.get(target.taskId);
        return `| ${escaped(target.taskId)} | ${record ? attemptStatus(record) : "pending"} | [${escaped(target.title)}](points/${target.id}/report.md) | [metrics.json](points/${target.id}/metrics.json) |`;
      }),
      "", "测量点完成与正式可比性分别记录，请在各自报告中核对上游有效性、请求错误和采集状态。", ""].join("\n");
  }
}
