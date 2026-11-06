import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Parse msprof OPPROF_* artifacts, preserving the semantics of
 * msprof_op_profiler.parse_msprof_dir and metrics_to_prompt without NPU or pandas dependencies.
 */

/** Operator metric columns retained from msprof output, grouped by pipeline utilization,
 * resource waits, memory traffic and bandwidth, and arithmetic utilization.
 * Exclude Task Duration(us), which differs from the authoritative timing scope, and Block Dim.
 * Exclude MemoryUB.csv bandwidth because it duplicates ub_ratio. */
export const MSPROF_METRIC_COLUMNS: readonly string[] = [
  "block_id",
  // PipeUtilization.csv: pipeline utilization.
  "aic_time(us)", "aic_cube_ratio", "aic_scalar_ratio", "aic_mte1_ratio", "aic_mte2_ratio", "aic_mte3_ratio",
  "aiv_time(us)", "aiv_vec_ratio", "aiv_scalar_ratio", "aiv_mte2_ratio", "aiv_mte3_ratio",
  "aic_read_hit_rate(%)", "aic_write_hit_rate(%)", "aiv_read_hit_rate(%)", "aiv_write_hit_rate(%)",
  "core_utilization",
  // ResourceConflictRatio.csv: memory conflicts and pipeline waits that indicate bottlenecks.
  "aiv_vec_stu_cflt_ratio", "aiv_vec_ldu_cflt_ratio", "aiv_vec_sfu_cflt_ratio",
  "aiv_vec_wait_ratio", "aiv_mte2_wait_ratio", "aiv_mte3_wait_ratio",
  // Memory.csv: measured bandwidth and transfer volume.
  "aiv_gm_to_ub_bw(GB/s)", "aiv_main_mem_read_bw(GB/s)",
  // Omit write bandwidth: output traffic is fixed and bandwidth follows from write volume and kernel time.
  "GM_to_UB_bw_usage_rate(%)", "read_main_memory_datas(KB)", "write_main_memory_datas(KB)",
  "aiv_mte2_instructions",
  // ArithmeticUtilization.csv: vector and special-function unit utilization.
  "aiv_vec_vf_ratio", "aiv_vec_sfu_ratio",
];

/** A row keyed by block_id with numeric, string or missing metric values. */
export type MetricRow = { block_id: string } & Record<string, unknown>;

/** Parse unquoted msprof CSV fields, tolerating CRLF and trailing empty lines. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return { header: [], rows: [] };
  const split = (line: string) => line.split(",");
  return { header: split(lines[0]!), rows: lines.slice(1).map(split) };
}

/** Read an msprof table or return null; callers decide which tables are required. */
async function readTable(profDir: string, name: string): Promise<Record<string, unknown>[] | null> {
  let text: string;
  try {
    text = await readFile(join(profDir, name), "utf8");
  } catch {
    return null;
  }
  const { header, rows } = parseCsv(text);
  return rows.map(cells => Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ""])));
}

/** Convert finite numeric cells to numbers and empty/nonnumeric strings to null; archive raw CSV separately. */
function coerce(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    if (Number.isFinite(Number(trimmed)) && trimmed !== "") return Number(trimmed);
    return null;
  }
  return raw;
}

/** Preserve pipe-table values for duplicate columns; never overwrite block or sub-block identities. */
function mergeInto(base: Record<string, unknown>, extra: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(extra)) {
    if (key === "block_id" || key === "sub_block_id") continue;
    if (base[key] === undefined) base[key] = value;
  }
}

/**
 * Parse an OPPROF_* directory into metric rows using parse_msprof_dir semantics.
 * Require PipeUtilization, L2Cache and ResourceConflictRatio; missing tables mean incomplete capture.
 * Memory and ArithmeticUtilization are optional because cube-only operators may have no AIV data.
 * Keep only the final row under the original LAST selection policy.
 */
export async function parseMsprofMetricsTable(profDir: string): Promise<MetricRow[]> {
  const pipe = await readTable(profDir, "PipeUtilization.csv");
  if (pipe === null) throw new Error(`No PipeUtilization.csv found under ${profDir}`);
  const l2 = await readTable(profDir, "L2Cache.csv");
  if (l2 === null) throw new Error(`No L2Cache.csv found under ${profDir}`);
  const conflict = await readTable(profDir, "ResourceConflictRatio.csv");
  if (conflict === null) throw new Error(`No ResourceConflictRatio.csv found under ${profDir}`);

  // Outer-join companion tables by block_id, preserving pipe rows and adding companion-only rows.
  const byBlock = new Map<string, Record<string, unknown>>();
  for (const row of pipe) {
    const key = String(row["block_id"]);
    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) record[k] = coerce(v);
    byBlock.set(key, record);
  }
  for (const extra of [l2, conflict, ...(await Promise.all(
    [readTable(profDir, "Memory.csv"), readTable(profDir, "ArithmeticUtilization.csv")]))]) {
    for (const row of extra ?? []) {
      const key = row["block_id"];
      if (key === undefined) continue;
      const existing = byBlock.get(String(key));
      if (existing === undefined) {
        const record: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) record[k] = coerce(v);
        byBlock.set(String(key), record);
      } else {
        mergeInto(existing, Object.fromEntries(Object.entries(row).map(([k, v]) => [k, coerce(v)])));
      }
    }
  }

  let rows = [...byBlock.values()] as MetricRow[];
  // Keep allowlisted columns; drop entirely empty columns that do not apply to this operator type.
  const kept = MSPROF_METRIC_COLUMNS.filter(name => name === "block_id" ||
    rows.some(row => row[name] !== undefined && row[name] !== null));
  rows = rows.map(row => Object.fromEntries(kept.map(name => [name, name === "block_id" ? String(row[name]) : row[name] ?? null]))) as MetricRow[];
  // LAST selection policy: retain the final row.
  return rows.length <= 1 ? rows : [rows[rows.length - 1]!];
}

/** Key metrics by block_id, omitting the identity from each value object.
 * Round numbers to three decimal places; omit null metrics that are unavailable for the block. */
export function rowsToMetrics(rows: MetricRow[]): Record<string, Record<string, unknown>> {
  const data: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const values = Object.fromEntries(
      Object.entries(row).filter(([name, value]) => name !== "block_id" && value !== null)
        .map(([name, value]) => [name, typeof value === "number" ? Math.round(value * 1000) / 1000 : value]));
    data[String(row["block_id"])] = values;
  }
  return data;
}

/** Serialize metrics to CSV for archiving and reconciliation, matching metrics_df.to_csv. */
export function metricsToCsv(rows: MetricRow[]): string {
  const header = rows.length === 0 ? [] : Object.keys(rows[0]!);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    return String(value);
  };
  return [header.join(","), ...rows.map(row => header.map(name => escape(row[name])).join(","))].join("\n") + "\n";
}
