import type { JsonValue } from "../../core/contracts/task.js";
import { expectRecord } from "../../core/validation/input.js";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replace(/[\\`*_\[\]()|~]/gu, "\\$&").replace(/\r?\n/gu, " ");
const number = (value: unknown, digits = 6) => typeof value === "number" && Number.isFinite(value)
  ? value.toFixed(digits).replace(/\.?0+$/u, "") : "—";
const encodePath = (value: string) => value.split("/").map(part => encodeURIComponent(part)
  .replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

function safePath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\\") && !/[\u0000-\u001f]/u.test(value) &&
    value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function resultLink(row: Record<string, unknown>, root: string): string {
  return typeof row.evidencePath === "string" && safePath(row.evidencePath)
    ? `[result.json](${root}${encodePath(row.evidencePath)}/result.json)` : "—";
}

function artifactLink(row: Record<string, unknown>, path: unknown, root: string, label: string): string {
  return safePath(row.evidencePath) && safePath(path)
    ? `[${escape(label)}](${root}${encodePath(`${row.evidencePath}/verifier/${path}`)})` : "—";
}

function range(value: unknown, original = false): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
  const stat = expectRecord(value, "kernel metric range");
  const textValues = Array.isArray(stat.textValues) ? stat.textValues.filter((item): item is string => typeof item === "string") : [];
  if (typeof stat.minimum !== "number" || typeof stat.maximum !== "number" ||
    !Number.isFinite(stat.minimum) || !Number.isFinite(stat.maximum)) return textValues.map(escape).join("; ") || "—";
  const format = original ? String : number;
  const text = stat.minimum === stat.maximum ? format(stat.minimum) : `${format(stat.minimum)}–${format(stat.maximum)}`;
  const rendered = stat.available === stat.total ? text : `${text} (${stat.available}/${stat.total})`;
  return [rendered, ...textValues.map(escape)].join("; ");
}

/** 详细 block 数据留在机器结果中，报告给出范围和可追溯的原始证据。 */
export function renderKernelTables(value: JsonValue | undefined, evidenceRoot = ""): string[] {
  if (value === undefined) return [];
  const metric = expectRecord(value, "kernel metric");
  if (!Array.isArray(metric.rows)) throw new TypeError("Invalid kernel report rows");
  const rows = metric.rows.map(value => expectRecord(value, "kernel report row"));
  const lines = ["## 算子正确性与性能", "",
    `正确 ${number(metric.passed)} / ${number(metric.selected)}；有效计时 ${number(metric.measured)}；加速 ${number(metric.faster)}；加速比几何均值 ${number(metric.geometricMeanSpeedup)}。`, "",
    "正确性通过不代表性能提升。加速比为参考耗时 / 候选耗时；耗时只含设备 kernel，详细 profiler 重放不参与该计时。", "",
    "| 任务 | 有效 / 正确 | 参考种类 | 参考 (ms) | 候选 (ms) | 加速比 | 证据 |",
    "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of rows) lines.push(
    `| ${escape(String(row.taskId))} | ${row.valid} / ${row.passed} | ${escape(String(row.referenceKind ?? "—"))} | ${number(row.referenceMs)} | ${number(row.candidateMs)} | ${number(row.speedup)} | ${resultLink(row, evidenceRoot)} |`,
  );
  if (!rows.some(row => row.profilingRequested === true || row.profiling != null)) {
    lines.push("", "详细 profiling 未启用或历史结果未记录采集状态。", "");
    return lines;
  }
  const kernelRows = rows.flatMap(row => {
    if (!row.profiling || typeof row.profiling !== "object" || Array.isArray(row.profiling)) return [];
    const profile = expectRecord(row.profiling, "kernel profiling summary");
    if (!Array.isArray(profile.kernels)) throw new TypeError("Invalid kernel profiling kernels");
    return profile.kernels.map(value => ({ row, kernel: expectRecord(value, "kernel profiling kernel") }));
  });
  const kernelLastBlock = kernelRows.some(({ kernel }) => kernel.outputPolicy === "kernel-last-block-v1");
  const kernelOriginal = kernelRows.some(({ kernel }) => kernel.outputPolicy === "kernel-original-f542-v1");
  lines.push("", "### 详细 profiling", "",
    `已请求 ${number(metric.profilingRequested)}；完成 ${number(metric.profiled)}；失败 ${number(metric.profilingErrors)}；未采集 ${number(metric.profilingUncollected)}。覆盖率以全部所选任务为分母：${number(metric.profiled)} / ${number(metric.selected)}。`, "",
    "采集状态独立记录；原 profiler 返回 None 或采集失败不改变已经得到的正确性、计时与加速比。", "");
  if (kernelOriginal) lines.push("标记原 kernel 的行直接采用固定版本 _profile_kernel_impl() 的返回值，字段、数值与缺失行为由原函数决定。报告不重新判定指标有效性；原始返回见 original-result.json。", "");
  lines.push(
    kernelLastBlock
      ? "标记 kernel LAST 的行按原返回合并后排序选取 LAST block，CSV 指标与 UB 比率舍入到三位小数、缺失字段省略；core 与 L2 分析按原流程后补，资源元数据保留原始精度。未标记的历史行仍展示已有 block 的范围，不计算无权平均。全量 block 原始值见 raw-metrics.json。"
      : kernelOriginal ? "表格显示原返回的数值与文本；多条数值仅给出范围，不计算无权平均。历史未标记结果仍显示其原有 block 范围。"
        : "以下为候选 kernel 的 block 指标范围，同一 block 的重复行均保留，不计算无权平均。",
    "括号为数值样本 / 主结果样本；表格中的缺失项显示 —，不补零。管道比率沿用原始 CSV 单位，UB 与核覆盖率为 0–1 比率，L2 列单位为 %；这些比率不等同于 GB/s 或 FLOPS。", "");
  if (kernelLastBlock || kernelOriginal) {
    lines.push("| 任务 / kernel | 主结果口径 | 已记录 block | 原始返回 / 全量证据 |", "| --- | --- | --- | --- |");
    for (const { row, kernel } of kernelRows) {
      const original = kernel.outputPolicy === "kernel-original-f542-v1";
      lines.push(`| ${escape(String(row.taskId))} / ${escape(String(kernel.name))} | ${original ? "原 kernel" : kernel.outputPolicy === "kernel-last-block-v1" ? "kernel LAST" : "历史 block 范围"} | ${escape(String(kernel.selectedBlockId ?? "—"))} | ${artifactLink(row, original ? kernel.originalResultJson : kernel.rawMetricsJson, evidenceRoot, original ? "original-result.json" : "raw-metrics.json")} |`);
    }
    lines.push("");
  }
  lines.push(
    "| 任务 / kernel | block / 样本 | Vector | MTE2 | MTE3 | L2 读 / 写 (%) | UB | 核覆盖率 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    if (!row.profiling || typeof row.profiling !== "object" || Array.isArray(row.profiling)) continue;
    const profile = expectRecord(row.profiling, "kernel profiling summary");
    if (!Array.isArray(profile.kernels)) throw new TypeError("Invalid kernel profiling kernels");
    for (const value of profile.kernels) {
      const kernel = expectRecord(value, "kernel profiling kernel");
      const values = expectRecord(kernel.values, "kernel profiling values");
      const metric = (value: unknown) => range(value, kernel.outputPolicy === "kernel-original-f542-v1");
      lines.push(`| ${escape(String(row.taskId))} / ${escape(String(kernel.name))} | ${kernel.blockCount} / ${kernel.sampleCount} | ${metric(values.aiv_vec_ratio)} | ${metric(values.aiv_mte2_ratio)} | ${metric(values.aiv_mte3_ratio)} | ${metric(values["aiv_read_hit_rate(%)"])} / ${metric(values["aiv_write_hit_rate(%)"])} | ${metric(values.ub_ratio)} | ${metric(values.core_utilization)} |`);
    }
  }
  if (kernelRows.some(({ kernel }) => kernel.outputPolicy !== "kernel-original-f542-v1")) lines.push("", "| 任务 / kernel | UB 需求 (bits) / 容量 (KiB) | 向量核已用 / 总数 | 资源信息缺失原因 |",
    "| --- | --- | --- | --- |");
  for (const row of rows) {
    const profile = row.profiling && typeof row.profiling === "object" && !Array.isArray(row.profiling)
      ? expectRecord(row.profiling, "kernel profiling summary") : null;
    if (!Array.isArray(profile?.kernels)) continue;
    for (const value of profile.kernels) {
      const kernel = expectRecord(value, "kernel profiling kernel");
      if (kernel.outputPolicy === "kernel-original-f542-v1") continue;
      const resources = kernel.resources && typeof kernel.resources === "object" && !Array.isArray(kernel.resources)
        ? expectRecord(kernel.resources, "kernel resources") : {};
      const ub = resources.ub && typeof resources.ub === "object" && !Array.isArray(resources.ub)
        ? expectRecord(resources.ub, "kernel UB") : {};
      const cores = resources.vectorCores && typeof resources.vectorCores === "object" && !Array.isArray(resources.vectorCores)
        ? expectRecord(resources.vectorCores, "kernel vector cores") : {};
      const reasons = [ub.reason, cores.reason].filter((reason): reason is string => typeof reason === "string");
      lines.push(`| ${escape(String(row.taskId))} / ${escape(String(kernel.name))} | ${number(ub.requiredBits)} / ${number(ub.capacityKb)} | ${number(cores.used)} / ${number(cores.total)} | ${escape(reasons.join("; ")) || "—"} |`);
    }
  }
  lines.push("", "### L2 缓存分析", "",
    "展示已保存的 L2 规则分析，不重新运行规则或补齐结论。这是规则提示，不证明瓶颈或性能收益；数据不足不等于没有优化空间。依据与缺失原因各最多列 3 条，完整内容见 result.json。", "",
    "| 任务 / kernel | 结论 | 依据 | 缺失原因 |", "| --- | --- | --- | --- |");
  for (const row of rows) {
    const profile = row.profiling && typeof row.profiling === "object" && !Array.isArray(row.profiling)
      ? expectRecord(row.profiling, "kernel profiling summary") : null;
    if (!Array.isArray(profile?.kernels)) continue;
    for (const value of profile.kernels) {
      const kernel = expectRecord(value, "kernel profiling kernel");
      const analysis = kernel.l2CacheAnalysis && typeof kernel.l2CacheAnalysis === "object" && !Array.isArray(kernel.l2CacheAnalysis)
        ? expectRecord(kernel.l2CacheAnalysis, "kernel L2 analysis") : null;
      const conclusion = analysis === null ? "未记录" : kernel.outputPolicy === "kernel-original-f542-v1" && typeof analysis.conclusion === "string"
        ? analysis.conclusion : analysis.optimization === true ? "可能存在优化空间"
        : analysis.optimization === false ? "未观察到明显优化空间" : "数据不足";
      const excerpt = (value: unknown, total: unknown) => {
        const entries = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
        const remaining = typeof total === "number" && total > entries.length ? `；另 ${total - entries.length} 条见 result.json` : "";
        return escape(entries.join("; ") + remaining) || "—";
      };
      lines.push(`| ${escape(String(row.taskId))} / ${escape(String(kernel.name))} | ${escape(conclusion)} | ${excerpt(analysis?.evidence, analysis?.evidenceCount)} | ${excerpt(analysis?.unavailable, analysis?.unavailableCount)} |`);
    }
  }
  lines.push("", "| 任务 | 采集状态 | 错误 | 完整 block 数据 / 原始证据 |", "| --- | --- | --- | --- |");
  for (const row of rows) {
    const profile = row.profiling && typeof row.profiling === "object" && !Array.isArray(row.profiling)
      ? expectRecord(row.profiling, "kernel profiling summary") : null;
    const files = new Set<unknown>(Array.isArray(profile?.artifacts) ? profile.artifacts : []);
    if (Array.isArray(profile?.kernels)) for (const value of profile.kernels) {
      const kernel = expectRecord(value, "kernel profiling kernel");
      if (Array.isArray(kernel.artifacts)) for (const file of kernel.artifacts) files.add(file);
    }
    const links = [resultLink(row, evidenceRoot)];
    if (typeof row.evidencePath === "string" && safePath(row.evidencePath)) for (const file of files) {
      if (!safePath(file)) continue;
      // 二进制采集片段仍在完整证据清单中，正文只列便于复核的表、trace 和日志。
      if (!/(?:\.csv|\.log|\/(?:trace|result|metrics|raw-metrics|original-result)\.json)$/iu.test(file)) continue;
      const target = encodePath(`${row.evidencePath}/verifier/${file}`);
      links.push(`[${escape(file)}](${evidenceRoot}${target})`);
    }
    lines.push(`| ${escape(String(row.taskId))} | ${escape(String(profile?.status ?? (row.profilingRequested ? "未采集" : "未启用")))} | ${escape(String(profile?.error || "—"))} | ${links.join(" · ")} |`);
  }
  for (const row of rows) {
    const profile = row.profiling && typeof row.profiling === "object" && !Array.isArray(row.profiling)
      ? expectRecord(row.profiling, "kernel profiling summary") : null;
    if (typeof profile?.serializationConversions === "number" && profile.serializationConversions > 0)
      lines.push("", `${escape(String(row.taskId))} 有 ${number(profile.serializationConversions)} 项 JSON 边界转换；字段路径及原值见 result.json 的 serializationConversions，未改动原 profiler 算法。`, "");
  }
  lines.push("", "结果还包括 Cube、Scalar、AIC 搬运、资源冲突、等待比率，以及可用的 Memory/Arithmetic 字段，见 result.json。实际带宽字段保留 GB/s、数据量保留 CSV 标注的 KB、带宽使用率保留 %，其余比率不做单位换算。",
    kernelOriginal ? "原 kernel 的完整返回见 original-result.json；原始 CSV 和 trace 仍在证据清单中。" : kernelLastBlock ? "kernel LAST 对应的全量原始 block 值见 raw-metrics.json；历史未标记行的完整数据见 result.json。" : "完整 block 数据见 result.json。",
    kernelOriginal ? "原始 CSV 和 trace 链接用于复核。原 kernel 的核覆盖率沿用原实现统计与分母，不等同于时间利用率。"
      : "原始 CSV 和 trace 链接用于复核。核覆盖率表示观察到的向量核数量占设备向量核总数，不等同于时间利用率。", "");
  return lines;
}
