import type { JsonValue } from "../../core/contracts/task.js";
import { expectRecord } from "../../core/validation/input.js";
import { parseAgentXSummary, type AgentXStatistic } from "../benchmarks/inference-engine/agentx/evidence/summary.js";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replace(/[\\`*_\[\]()|~]/gu, "\\$&").replace(/\r?\n/gu, " ");
const number = (value: number | null | undefined) => value == null ? "—" : value.toFixed(3).replace(/\.?0+$/u, "");

export function renderAgentXTables(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  const metric = expectRecord(value, "agentx-performance metric");
  if (metric.applicable !== true) return [];
  if (!Array.isArray(metric.points)) throw new TypeError("Invalid AgentX report points");
  const lines = ["## AgentX serving performance", "",
    "会话并发是同时活动的会话树数，实际请求并发可能更高。下表仅使用 profiling 统计；预热单列。分位数分别属于各测量点。", "",
    "| 测量点 | 状态 | 会话并发 | 场景 / 语料 | 上游有效 | 可比正式结果 | 成功请求 / 错误请求 | 测量秒数 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  const summaries = metric.points.map(value => {
    const point = expectRecord(value, "AgentX report point");
    const summary = point.measurement === null ? null : parseAgentXSummary(point.measurement);
    lines.push(`| ${escape(String(point.taskId))} | ${escape(String(point.status))} | ${summary?.workload.concurrency ?? "—"} | ${summary ? `${summary.workload.mode} / ${summary.workload.variant}` : "—"} | ${summary?.upstreamSubmissionValid ?? "—"} | ${summary?.comparable ?? "—"} | ${number(summary?.profiling.requests?.mean)} / ${number(summary?.profiling.errors?.mean)} | ${number(summary?.profiling.duration?.mean)} |`);
    return { taskId: String(point.taskId), summary };
  });
  lines.push("", metric.points.length > 1 ? "### 并发点性能对比" : "### 测量点性能", "",
    "| 测量点 | 会话并发 | 输出吞吐 (tokens/sec) | 总 token 吞吐 (tokens/sec) | TTFT P50 / P95 (ms) | ITL P50 / P95 (ms) | 请求延迟 P95 (ms) |",
    "| --- | --- | --- | --- | --- | --- | --- |");
  for (const { taskId, summary } of summaries) {
    const stats = summary?.profiling;
    lines.push(`| ${escape(taskId)} | ${summary?.workload.concurrency ?? "—"} | ${number(stats?.outputThroughput?.mean)} | ${number(stats?.totalThroughput?.mean)} | ${number(stats?.ttft?.p50)} / ${number(stats?.ttft?.p95)} | ${number(stats?.itl?.p50)} / ${number(stats?.itl?.p95)} | ${number(stats?.requestLatency?.p95)} |`);
  }
  const labels: Record<string, string> = { ttft: "TTFT", itl: "ITL", requestLatency: "请求延迟",
    inputThroughput: "输入吞吐", outputThroughput: "输出吞吐", totalThroughput: "总 token 吞吐",
    interactivity: "Interactivity", fullResponseInteractivity: "Full-response Interactivity" };
  const row = (taskId: string, name: string, stat: AgentXStatistic | null | undefined) =>
    `| ${escape(taskId)} | ${name} | ${stat?.unit ?? "—"} | ${number(stat?.mean)} | ${number(stat?.p50)} | ${number(stat?.p95)} | ${number(stat?.p99)} | ${stat?.count ?? "—"} |`;
  for (const { taskId, summary } of summaries) {
    lines.push("", `### 测量点 ${escape(taskId)}`, "");
    if (!summary) {
      lines.push("暂无有效测量摘要；状态见上方测量点表。推理服务与硬件指标采集状态未知。", "");
      continue;
    }
    lines.push("| 测量点 | 指标 | 单位 | 均值 | P50 | P95 | P99 | 样本数 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const [key, label] of Object.entries(labels)) lines.push(row(taskId, label, summary.profiling[key]));
    lines.push("", `Harness ${summary.harnessVersion}；数据 ${escape(summary.workload.dataset)} @ ${summary.workload.revision}；tokenizer ${escape(summary.lexicon.source)} @ ${escape(summary.lexicon.revision)}。`, "",
      `预热：请求 ${number(summary.warmup.requests?.mean)}；输入 token ${number(summary.warmup.inputTokens?.mean)}；输出 token ${number(summary.warmup.outputTokens?.mean)}。`, "",
      `上游无效原因：${escape(summary.upstreamInvalidReasons.join(", ")) || "—"}；本地不可比原因：${escape(summary.incomparableReasons.join(", ")) || "—"}。`, "");
    if (summary.networkLatency) {
      const network = summary.networkLatency;
      const mode = network.config.mode === "automatic"
        ? `自动 TCP RTT 探测，间隔 ${number(network.config.pingIntervalSeconds)} 秒`
        : `手动 RTT，配置值 ${number(network.config.meanMs)} ms`;
      lines.push("#### 网络延时校准", "",
        `方式：${mode}；校准数据状态：${network.status}；官方用于校准的平均 RTT：${number(network.rttMs)} ms。`, "",
        network.probes ? `TCP 探测：总计 ${network.probes.total}；成功 ${network.probes.successful}；失败 ${network.probes.failed}。`
          : `TCP 探测：${network.config.mode === "manual" ? "不适用（手动指定 RTT）" : "未记录"}。`, "",
        `校准告警：${escape(network.warnings.join("; ")) || "—"}。`, "",
        "| 测量点 | 指标与口径 | 单位 | 均值 | P50 | P95 | P99 | 样本数 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const [key, label] of Object.entries({ ttft: "TTFT", ttfo: "TTFO（首个输出 token）", requestLatency: "请求延迟" })) {
        lines.push(row(taskId, `${label} 原始`, summary.profiling[key]));
        lines.push(row(taskId, `${label} 扣除 RTT 后`, network.adjusted[key]));
      }
      lines.push("", "修正值直接读取官方 Harness 导出，保留原始延迟；ITL、吞吐及上方性能对比表不做 RTT 扣减。平均 TCP RTT 只校准客户端到端点的往返估算，不能消除所有代理、传输或客户端开销。未导出的值显示 —，不补算。", "");
    }
    if (summary.replayCoverage) {
      const coverage = summary.replayCoverage;
      lines.push(`完整回放覆盖率：${coverage.completedTraces} / ${coverage.selectedTraces} 个 trace；${coverage.observedRequests} / ${coverage.expectedRequests} 次请求；成功 ${coverage.successfulRequests}，失败 ${coverage.failedRequests}，取消 ${coverage.cancelledRequests}；缺失 ${coverage.missingRequests}，重复 ${coverage.duplicateRequests}，未知 ${coverage.unexpectedRequests}。`, "");
    }
    if (summary.telemetry) {
      const vllm = summary.telemetry.sources.filter(source => source.kind === "vllm");
      const npu = summary.telemetry.sources.filter(source => source.kind === "ascend");
      const status = (sources: typeof npu) => sources.length ? sources.every(source => source.status === "complete") ? "complete"
        : sources.every(source => source.status === "unavailable") ? "unavailable" : "partial" : "未启用";
      lines.push(`采集状态：推理服务 ${status(vllm)}；${npu.length ? `NPU ${status(npu)}` : "硬件指标未启用"}。`, "",
        "采集状态表示已保存指标的数据可用性，不要求每次监控抓取都成功；请求测评有效性以 Harness 判断为准。", "",
        `监控抓取失败次数：${summary.telemetry.collectionErrors ?? "未记录"}（全部端点合计，不能归属到某个来源）。临时失败后继续采集，保留已获得的统计。`, "",
        "Gauge 沿用上游采样统计；Counter 按各端点的采集顺序计算窗口内增量与每秒速率，不按可回拨的时间戳重排。窗口外快照不计入，可能与逐请求 token 汇总存在采样边界差额。各标签序列独立展示。硬件是指定设备与芯片的观察值，不代表单个请求独占的消耗。", "");
      for (const source of summary.telemetry.sources) {
        lines.push(`#### ${source.kind === "vllm" ? "推理服务" : `NPU ${source.deviceId} / chip ${source.chipId ?? "未发现"}`}`, "",
          `来源 ${source.kind}：${escape(source.endpoint ?? "未启动")}；采集状态 ${source.status}；profiling 样本 ${source.samples}；预热样本 ${source.warmupSamples}${source.kind === "ascend" ? `；物理 NPU ${source.deviceId} / chip ${source.chipId ?? "未发现"}` : ""}。`, "",
          `profiling 聚合窗口（Unix ns）：${source.window ? `${source.window.startNs} — ${source.window.endNs}` : "—"}；预热窗口：${source.warmupWindow ? `${source.warmupWindow.startNs} — ${source.warmupWindow.endNs}` : "—"}。窗口沿用 Harness，可能包含最终采样边界。`, "",
          `未提供指标：${escape(source.missingMetrics.join(", ")) || "—"}；采集问题：${escape(source.errors.join("; ")) || "—"}。`, "",
          `采样告警：${escape(source.warnings?.join("; ") ?? "") || "—"}。`, "",
          "| 阶段 | 指标 | 标签 | 单位 | 均值 | 最小 | 最大 | 增量 | 每秒速率 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
        for (const [phase, series] of [["profiling", source.series], ["warmup", source.warmupSeries]] as const) {
          for (const s of series) lines.push(`| ${phase} | ${escape(s.metric)} | ${escape(JSON.stringify(s.labels))} | ${s.unit} | ${number(s.mean)} | ${number(s.min)} | ${number(s.max)} | ${number(s.total)} | ${number(s.rate)} |`);
          const labelKey = (tags: Record<string, string>) => JSON.stringify(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)));
          for (const hits of series.filter(s => s.metric === "vllm:prefix_cache_hits")) {
            const queries = series.find(s => s.metric === "vllm:prefix_cache_queries" && labelKey(s.labels) === labelKey(hits.labels));
            const ratio = hits.total !== null && queries?.total && queries.total > 0 ? hits.total / queries.total : null;
            lines.push(`| ${phase} | prefix cache 命中率 | ${escape(JSON.stringify(hits.labels))} | ratio | ${number(ratio)} | — | — | — | — |`);
          }
        }
        lines.push("");
      }
      lines.push("监控缺失或告警不改变请求吞吐、延迟和 Harness 的测评有效性；使用硬件统计时需同时核对可用样本和采集问题。", "");
    } else {
      lines.push("采集状态：推理服务未启用；硬件指标未启用。", "");
    }
  }
  lines.push("缺失值显示 —，不补成 0。usage 仅汇总预热与 profiling 均有统计的已知 token 数，不代表服务商账单。", "");
  return lines;
}
