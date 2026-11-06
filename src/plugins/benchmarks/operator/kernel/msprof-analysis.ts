import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, type MetricRow } from "./msprof-csv.js";

/**
 * msprof 采集附带分析（kernel 原版 _extract_triton_kernel_name / get_ub_ratio /
 * _get_core_utilization / l2_cache_analyzer 的 TS 语义移植）。
 * 纯计算，零 NPU。
 */

/**
 * NPU 规格表（kernel 原版 npu_specs.py / npu_specs_database.py 的 TS 语义移植）。
 * 纯静态数据：ub_size_kb 参与 ub_ratio 换算，vector_count 参与核利用率换算。
 */
export interface NpuSpecs {
  name: string;
  L2_cache_mb: number;
  L1_cache_kb: number;
  vector_count: number;
  ub_size_kb: number;
  cube_count: number;
  hbm_gb: number;
}

/** Ascend 芯片规格（来源：官方芯片规格 / npu-smi、CANN 硬件探测）。 */
const NPU_SPECS_DATABASE: Readonly<Record<string, NpuSpecs>> = {
  "ASCEND 950PR 128G": {
    name: "ASCEND 950PR 128G",
    L2_cache_mb: 128,
    L1_cache_kb: 512,
    vector_count: 56,
    ub_size_kb: 248,
    cube_count: 28,
    hbm_gb: 128,
  },
};

/** 按精确型号查规格；未知型号返回 null（调用方决定是否降级为默认型号）。 */
export function getNpuSpecs(deviceName: string): NpuSpecs | null {
  return NPU_SPECS_DATABASE[deviceName] ?? null;
}

/** 未指定型号时的兜底型号（与原版 get_ub_ratio 行为一致）。 */
export const DEFAULT_NPU_DEVICE = "ASCEND 950PR 128G";

/** 从 Triton kernel 源码提取 @jit（含 @triton.jit 点分形式）函数名；找不到回退文件干。 */
export function extractTritonKernelName(kernelFile: string, source: string): string {
  const stem = kernelFile.split(/[/\\]/).pop()?.replace(/\.py$/, "") ?? "kernel";
  const lines = source.split("\n");
  let pendingJit = false;
  for (const line of lines) {
    const decorator = line.match(/^\s*@([\w.]+)(\(|\s|$)/);
    if (decorator) {
      pendingJit = decorator[1]!.split(".").pop() === "jit";
      continue;
    }
    const def = line.match(/^\s*(?:async\s+)?def\s+(\w+)/);
    if (def) {
      if (pendingJit) return def[1]!;
      pendingJit = false;
    }
  }
  return stem;
}

/** 在 Triton cache 里按名找编译元数据 json；只认精确文件名 `<kernel>.json`，
 * 按内容兜底扫会拿到别的内核的元数据让 ub_ratio 悄悄算错 —— 宁缺勿错。 */
async function findCompileMetadata(tritonCacheDir: string, kernelName: string): Promise<string | null> {
  const search = async (dir: string): Promise<string | null> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) return null;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = await search(path);
        if (hit !== null) return hit;
      } else if (entry.name === `${kernelName}.json`) return path;
    }
    return null;
  };
  return search(tritonCacheDir);
}

/**
 * 从 msprof stdout 与 Triton 编译元数据解析 ub_ratio（get_ub_ratio 语义）。
 * 读不到编译元数据返回 null（ub_ratio 只是诊断细节，不该带走整次剖析）；
 * 型号缺失按默认型号兜底；required_ub_bits 超容量抛错（数值不可能，报错优于错值）。
 */
export async function resolveUbRatio(stdout: string, tritonCacheDir: string,
  kernelName: string, deviceName?: string): Promise<number | null> {
  let metadataPath: string | null = null;
  const winner = stdout.match(/best config selected: BLOCK_M: (\d+), BLOCK_D: (\d+)/);
  if (winner) {
    // autotune 场景：从日志配对「BLOCK 组合 → 编译产物 hash」，只认胜出组合的元数据。
    const pairs: Array<[string, string, string]> = [];
    let pos = 0;
    for (;;) {
      const i = stdout.indexOf("Autotuning kernel", pos);
      if (i === -1) break;
      const next = stdout.indexOf("Autotuning kernel", i + 1);
      const segment = stdout.slice(i, next === -1 ? stdout.length : next);
      const config = segment.match(/Auto\S+ kernel[^\n]*with config BLOCK_M: (\d+), BLOCK_D: (\d+)/);
      const hash = segment.match(/\[DEBUG\] cmd_list:[^\n]*[/\\]([A-Z0-9]+)[/\\]/);
      if (config && hash) pairs.push([config[1]!, config[2]!, hash[1]!]);
      pos = i + 1;
    }
    const win = pairs.find(([bm, bd]) => bm === winner[1] && bd === winner[2]);
    if (win === undefined) throw new Error(`No hash found for BLOCK_M=${winner[1]}, BLOCK_D=${winner[2]}`);
    metadataPath = join(tritonCacheDir, win[2], `${kernelName}.json`);
    if (!existsSync(metadataPath)) metadataPath = null;
  } else {
    metadataPath = await findCompileMetadata(tritonCacheDir, kernelName);
  }
  if (metadataPath === null) return null;
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { required_ub_bits?: number };
  const requiredUbBits = metadata["required_ub_bits"];
  if (typeof requiredUbBits !== "number") throw new Error(`missing required_ub_bits in ${metadataPath}`);
  const specs = getNpuSpecs(deviceName ?? DEFAULT_NPU_DEVICE);
  if (specs === null) throw new Error(`device_name '${deviceName}' not found in NPU specs; cannot determine ub_size_kb`);
  const ratio = requiredUbBits / (specs.ub_size_kb * 8 * 1024);
  if (ratio > 1.0)
    throw new Error(`ub_ratio ${ratio.toFixed(4)} > 1.0 for kernel '${kernelName}': ` +
      `required_ub_bits=${requiredUbBits} exceeds ub_size_kb=${specs.ub_size_kb} capacity`);
  return ratio;
}

/** 从 trace.json 统计被占用的向量核数占比（_get_core_utilization 语义）。 */
export async function getCoreUtilization(profDir: string): Promise<number> {
  let trace: { traceEvents?: Array<{ pid?: unknown }> };
  try {
    trace = JSON.parse(await readFile(join(profDir, "trace.json"), "utf8"));
  } catch {
    throw new Error(`No trace.json found under ${profDir}`);
  }
  const usedCores = new Set<string>();
  for (const event of trace.traceEvents ?? []) {
    if (typeof event.pid === "string" && event.pid.toLowerCase().includes(".veccore"))
      usedCores.add(event.pid);
  }
  const specs = getNpuSpecs(DEFAULT_NPU_DEVICE)!;
  return usedCores.size / specs.vector_count;
}

function number(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readCsvRows(profDir: string, name: string): Promise<Record<string, string>[]> {
  const { readFile: rf } = await import("node:fs/promises");
  const text = await rf(join(profDir, name), "utf8");
  const { header, rows } = parseCsv(text);
  return rows.map(cells => Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ""])));
}

/** L2 命中率 × 访存占比交叉分析（l2_cache_analyzer 语义）：块级证据字符串列表。 */
export async function analyzeL2Cache(profDir: string): Promise<{
  l2_cache_optimization: boolean | null;
  conclusion: string;
  evidence: string[];
}> {
  const [l2Rows, pipeRows] = await Promise.all([readCsvRows(profDir, "L2Cache.csv"), readCsvRows(profDir, "PipeUtilization.csv")]);
  const pipeByBlockSub = new Map(pipeRows.map(row => [`${row["block_id"]}|${row["sub_block_id"]}`, row]));
  const evidence: string[] = [];
  let matched = 0;
  for (const l2 of l2Rows) {
    const pipe = pipeByBlockSub.get(`${l2["block_id"]}|${l2["sub_block_id"]}`);
    if (pipe === undefined) continue;
    matched += 1;
    const subBlock = String(l2["sub_block_id"]);
    const prefix = subBlock.toLowerCase().includes("vector") ? "aiv" : "aic";
    const readHit = number(l2[`${prefix}_read_hit_rate(%)`]);
    const writeHit = number(l2[`${prefix}_write_hit_rate(%)`]);
    const mte2 = number(pipe[`${prefix}_mte2_ratio`]);
    const mte3 = number(pipe[`${prefix}_mte3_ratio`]);
    const compute = number(pipe[prefix === "aiv" ? "aiv_vec_ratio" : "aic_cube_ratio"]);
    if (readHit !== null && mte2 !== null && compute !== null && readHit < 100.0 && mte2 > compute)
      evidence.push(`block ${l2["block_id"]} (${subBlock}): read_hit_rate=${readHit}%, mte2_ratio=${mte2} > compute_ratio=${compute}`);
    if (writeHit !== null && mte3 !== null && compute !== null && writeHit < 100.0 && mte3 > compute)
      evidence.push(`block ${l2["block_id"]} (${subBlock}): write_hit_rate=${writeHit}%, mte3_ratio=${mte3} > compute_ratio=${compute}`);
  }
  if (evidence.length > 0)
    return { l2_cache_optimization: true, conclusion: "The operator has potential L2 Cache optimization space.", evidence };
  if (matched === 0)
    return { l2_cache_optimization: null, conclusion: "Insufficient data to determine L2 Cache optimization space.", evidence: ["No matching block/sub_block data found."] };
  return { l2_cache_optimization: false, conclusion: "No obvious L2 Cache optimization space is observed.",
    evidence: ["No block shows both poor L2 Cache hit rate and dominant corresponding memory-transfer utilization."] };
}

// ===== 流水线 trace 分析（kernel 原版 trace_analyzer.py 的 TS 语义移植；纯计算） =====

const TRACE_PIPES = ["SCALAR", "MTE2", "VECTOR", "CUBE", "MTE3"] as const;

/** bound 类型 → 固定优化建议（原版 skill 映射）。 */
const TRACE_FEEDBACK: Record<string, string[]> = {
  scalar_bound_candidate: ["reduce scalar/loop/branch overhead"],
  memory_bound_candidate: ["optimize data movement and improve data reuse"],
  vector_bound_candidate: ["optimize Vector computation and instruction scheduling"],
  no_bound: ["inspect pipeline bubbles and overlap"],
};

interface TraceEvent { ts: number; dur: number }
interface Interval { start: number; end: number }

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

function pipeOf(event: Record<string, unknown>): string {
  return String(event["tid"] ?? event["name"] ?? "").toUpperCase();
}

/** STEP 1：按 pid 分核，选执行跨度最大的核；无有效核事件返回 null。 */
function selectLongestCore(events: Record<string, unknown>[]): {
  core: string; events: { pipe: string; ts: number; dur: number }[]; span: number;
} | null {
  const cores = new Map<string, { pipe: string; ts: number; dur: number }[]>();
  for (const raw of events) {
    if (raw === null || typeof raw !== "object") continue;
    const pipe = pipeOf(raw);
    if (!TRACE_PIPES.includes(pipe as (typeof TRACE_PIPES)[number])) continue;
    const ts = number(raw["ts"]);
    const dur = number(raw["dur"]);
    if (raw["pid"] === undefined || ts === null || dur === null) continue;
    const pid = String(raw["pid"]);
    if (!cores.has(pid)) cores.set(pid, []);
    cores.get(pid)!.push({ pipe, ts, dur });
  }
  if (cores.size === 0) return null;
  let best: { core: string; events: { pipe: string; ts: number; dur: number }[]; span: number } | null = null;
  for (const [core, list] of cores) {
    const span = Math.max(...list.map(e => e.ts + e.dur)) - Math.min(...list.map(e => e.ts));
    if (best === null || span > best.span) best = { core, events: list, span };
  }
  return best;
}

/** 同一流水的时间区间合并（原版 merged）。 */
function mergedIntervals(events: TraceEvent[]): Interval[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const result: Interval[] = [];
  for (const e of sorted) {
    const last = result[result.length - 1];
    if (last === undefined || e.ts > last.end) result.push({ start: e.ts, end: e.ts + e.dur });
    else last.end = Math.max(last.end, e.ts + e.dur);
  }
  return result;
}

/** 两条流水的 overlap 总时长（原版 overlap 双指针）。 */
function overlapOf(a: Interval[], b: Interval[]): number {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    total += Math.max(0, Math.min(a[i]!.end, b[j]!.end) - Math.max(a[i]!.start, b[j]!.start));
    if (a[i]!.end <= b[j]!.end) i += 1;
    else j += 1;
  }
  return total;
}

/** 同一流水内部空泡（原版 bubble_stats）。 */
function bubbleStats(events: TraceEvent[]): { count: number; total_us: number; max_us: number } {
  const intervals = mergedIntervals(events);
  const gaps: number[] = [];
  for (let i = 0; i + 1 < intervals.length; i += 1)
    gaps.push(intervals[i + 1]!.start - intervals[i]!.end);
  return { count: gaps.length, total_us: round6(gaps.reduce((s, g) => s + g, 0)),
    max_us: gaps.length ? round6(Math.max(...gaps)) : 0.0 };
}

/** STEP 4：按 MTE2↔Compute 跨轮 overlap 判断 Double Buffer 有效性。 */
function doubleBuffer(mte2: TraceEvent[], compute: TraceEvent[]): {
  status: string; mte2_compute_alternating: boolean; comparable_rounds: number;
  overlap_rounds: number; overlap_round_percent: number;
} {
  const timeline = [...mte2.map(e => ({ ts: e.ts, name: "MTE2" })),
    ...compute.map(e => ({ ts: e.ts, name: "COMPUTE" }))].sort((a, b) => a.ts - b.ts);
  const compact: string[] = [];
  for (const item of timeline)
    if (compact[compact.length - 1] !== item.name) compact.push(item.name);
  const alternating = compact.length >= 4;

  const mte2Sorted = [...mte2].sort((a, b) => a.ts - b.ts);
  const computeSorted = [...compute].sort((a, b) => a.ts - b.ts);
  let comparable = 0;
  let overlapRounds = 0;
  for (let i = 0; i + 1 < mte2Sorted.length; i += 1) {
    const start = mte2Sorted[i]!.ts;
    const nextStart = mte2Sorted[i + 1]!.ts;
    const group = computeSorted.filter(c => c.ts >= start && c.ts < nextStart);
    if (group.length === 0) continue;
    comparable += 1;
    if (Math.max(...group.map(c => c.ts + c.dur)) > nextStart) overlapRounds += 1;
  }

  const status = comparable === 0 ? "insufficient_evidence"
    : overlapRounds === comparable ? "effective"
    : overlapRounds > 0 ? "partially_effective" : "ineffective_or_not_enabled";
  return { status, mte2_compute_alternating: alternating, comparable_rounds: comparable,
    overlap_rounds: overlapRounds,
    overlap_round_percent: comparable > 0 ? round6(overlapRounds / comparable * 100) : 0.0 };
}

/** STEP 3：按 trace 实际耗时判断候选 Bound（SCALAR/MTE2/compute 三者取最长）。 */
function traceBound(times: Record<string, number>, computeName: string): {
  type: string; dominant: string; dominantTime: number;
} {
  const candidates = ["SCALAR", "MTE2", computeName];
  const dominant = candidates.reduce((acc, p) => (times[p]! > times[acc]! ? p : acc));
  const boundMap: Record<string, string> = {
    SCALAR: "scalar_bound_candidate", MTE2: "memory_bound_candidate",
    VECTOR: "vector_bound_candidate", CUBE: "cube_bound_candidate",
  };
  return { type: boundMap[dominant]!, dominant, dominantTime: times[dominant]! };
}

export interface TracePipelineAnalysis {
  longest_core: string;
  core_span_us: number;
  bound: { type: string; evidence: string };
  pipeline: { compute: string; mte2_compute_overlap_percent: number | null;
    compute_mte3_overlap_percent: number | null; pipeline_parallel: boolean | "uncertain" };
  bubble: Record<"mte2" | "compute" | "mte3", { count: number; total_us: number; max_us: number }>;
  double_buffer: { status: string; mte2_compute_alternating: boolean; comparable_rounds: number;
    overlap_rounds: number; overlap_round_percent: number };
  optimization_feedback: string[];
}

/**
 * trace.json traceEvents → 流水线分析（原版 AscendPipelineAnalyzer.analyze 语义）：
 * 最长核 / 候选 Bound / MTE2↔Compute↔MTE3 overlap / 空泡 / Double Buffer 有效性 /
 * 固定优化建议。无有效核事件或输入非法返回 null（调用方按"无 trace 数据"跳过）。
 */
export function analyzeTraceEvents(rawEvents: unknown): TracePipelineAnalysis | null {
  const events = Array.isArray(rawEvents)
    ? rawEvents.filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
    : [];
  const longest = selectLongestCore(events);
  if (longest === null) return null;

  // STEP 2：主要流水分组（compute 优先 VECTOR，无 VECTOR 事件时退 CUBE）
  const pipes: Record<string, TraceEvent[]> = {};
  for (const p of TRACE_PIPES) pipes[p] = [];
  for (const e of longest.events)
    if (e.pipe in pipes) pipes[e.pipe]!.push({ ts: e.ts, dur: e.dur });
  const computeName = pipes["VECTOR"]!.length > 0 ? "VECTOR" : "CUBE";
  const compute = pipes[computeName]!;

  // STEP 3：候选 Bound + overlap + 空泡
  const times: Record<string, number> = {};
  for (const p of TRACE_PIPES) times[p] = pipes[p]!.reduce((s, e) => s + e.dur, 0);
  const bound = traceBound(times, computeName);

  const ovIn = overlapOf(mergedIntervals(pipes["MTE2"]!), mergedIntervals(compute));
  const ovOut = overlapOf(mergedIntervals(compute), mergedIntervals(pipes["MTE3"]!));
  const mte2Time = mergedIntervals(pipes["MTE2"]!).reduce((s, i) => s + (i.end - i.start), 0);
  const computeTime = mergedIntervals(compute).reduce((s, i) => s + (i.end - i.start), 0);
  const mte3Time = mergedIntervals(pipes["MTE3"]!).reduce((s, i) => s + (i.end - i.start), 0);
  const inBase = Math.min(mte2Time, computeTime);
  const outBase = Math.min(computeTime, mte3Time);

  const pipeline = {
    compute: computeName,
    mte2_compute_overlap_percent: inBase > 0 ? round6(ovIn / inBase * 100) : null,
    compute_mte3_overlap_percent: outBase > 0 ? round6(ovOut / outBase * 100) : null,
    pipeline_parallel: pipes["MTE2"]!.length === 0 || compute.length === 0
      ? "uncertain" as const
      : ovIn > 0 || ovOut > 0,
  };

  const bubble = {
    mte2: bubbleStats(pipes["MTE2"]!),
    compute: bubbleStats(compute),
    mte3: bubbleStats(pipes["MTE3"]!),
  };

  const db = doubleBuffer(pipes["MTE2"]!, compute);

  // STEP 5：固定建议映射 + Double Buffer 补充建议
  const feedback = [...(TRACE_FEEDBACK[bound.type] ?? [])];
  if (db.status === "ineffective_or_not_enabled") feedback.push("check or enable Double Buffer");
  else if (db.status === "partially_effective") feedback.push("improve Double Buffer overlap");

  return {
    longest_core: longest.core,
    core_span_us: round6(longest.span),
    bound: { type: bound.type,
      evidence: `${bound.dominant} has the largest trace duration (${bound.dominantTime.toFixed(6)} us)` },
    pipeline,
    bubble,
    double_buffer: db,
    optimization_feedback: feedback,
  };
}

