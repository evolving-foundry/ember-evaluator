/**
 * NPU roofline analysis using msprof pipeline utilization, ported from msprof_roofline.py.
 * This computation requires no NPU: it consumes the parsed profiling metrics table
 * {block_id: {metric: value}} and returns bottleneck classifications and pipeline utilization.
 *
 * Semantics preserved from the Python implementation:
 * - Break utilization ties in scalar, vec, mte2, mte3 order, matching max semantics.
 * - Classify as "no" when maximum utilization is below underutilizedThreshold.
 * - Detect tiling imbalance when maximum aiv_vec_time exceeds 1.3 times the minimum.
 * - Keep at_roofline false: pipeline utilization percentages cannot be compared with absolute SOL.
 *   Preserve the Python warning semantics rather than infer an unsupported stopping condition.
 */

export interface RooflineConfig {
  /** Minimum utilization (0-1) for a pipeline-bound classification. */
  boundThresholdPct: number;
  /** Classify as underutilized below this maximum utilization, before testing pipeline bounds. */
  underutilizedThresholdPct: number;
  /** Reserved roofline efficiency threshold; current NPU metrics cannot establish at_roofline. */
  thresholdPct: number;
}

export const DEFAULT_ROOFLINE_CONFIG: RooflineConfig = {
  boundThresholdPct: 0.4,
  underutilizedThresholdPct: 0.8,
  thresholdPct: 0.8,
};

/** msprof metric keys must match MSPROF_METRIC_COLUMNS in msprof-csv.ts. */
const AIV_RATIO_KEYS: readonly (readonly [pipe: string, key: string])[] = [
  ['scalar', 'aiv_scalar_ratio'],
  ['vec', 'aiv_vec_ratio'],
  ['mte2', 'aiv_mte2_ratio'],
  ['mte3', 'aiv_mte3_ratio'],
];

export interface RooflineResult {
  scalar_rate: number | null;
  vec_rate: number | null;
  mte2_rate: number | null;
  mte3_rate: number | null;
  efficiency_rate: number | null;
  at_roofline: boolean;
  bottleneck: string;
  warnings: string[];
  msprof_metrics: Record<string, Record<string, unknown>>;
}

type MetricsTable = Record<string, Record<string, unknown>>;

const vecTimeOf = (row: Record<string, unknown>): number => {
  const value = row['aiv_vec_time'];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const ratioOf = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Classify utilization; break ties in scalar, vec, mte2, mte3 order. */
function classifyBottleneck(ratios: Map<string, number>, config: RooflineConfig): string {
  let maxPipe = '';
  let maxValue = -Infinity;
  for (const [pipe, value] of ratios) {
    if (value > maxValue) {
      maxPipe = pipe;
      maxValue = value;
    }
  }
  if (maxValue < config.underutilizedThresholdPct) return 'no';
  return maxValue > config.boundThresholdPct ? maxPipe : 'no';
}

export function analyzeRoofline(
  metricsTable: MetricsTable,
  config: RooflineConfig = DEFAULT_ROOFLINE_CONFIG,
): RooflineResult {
  const warnings: string[] = [];
  const blocks = Object.entries(metricsTable).filter(([, row]) => row !== null && typeof row === 'object');
  if (blocks.length === 0) {
    warnings.push('Empty msprof_metrics');
    return {
      scalar_rate: null, vec_rate: null, mte2_rate: null, mte3_rate: null,
      efficiency_rate: null, at_roofline: false, bottleneck: 'no',
      warnings, msprof_metrics: {},
    };
  }

  // Select maximum/minimum aiv_vec_time blocks; use the maximum block for downstream metrics.
  let maxBlock = blocks[0]!;
  let minBlock = blocks[0]!;
  for (const entry of blocks) {
    if (vecTimeOf(entry[1]) > vecTimeOf(maxBlock[1])) maxBlock = entry;
    if (vecTimeOf(entry[1]) < vecTimeOf(minBlock[1])) minBlock = entry;
  }
  const maxTime = vecTimeOf(maxBlock[1]);
  const minTime = vecTimeOf(minBlock[1]);
  const analysisRow = maxBlock[1];

  // Tiling imbalance: maximum vec_time exceeds the minimum by more than 30%.
  const isTilingBound = maxTime > minTime * 1.3;
  const selectedMetrics: Record<string, Record<string, unknown>> = { [maxBlock[0]]: maxBlock[1] };
  if (isTilingBound) {
    selectedMetrics[minBlock[0]] = minBlock[1];
    warnings.push(
      `tiling bound: max vec_time ${maxTime.toFixed(1)}us > 1.3 * min vec_time ${minTime.toFixed(1)}us`,
    );
  }

  // Read AIV utilization from the maximum vec_time row; retain unavailable values and warn on missing keys.
  const ratios = new Map<string, number>();
  const missing: string[] = [];
  for (const [pipe, key] of AIV_RATIO_KEYS) {
    const value = analysisRow[key];
    if (value === null || value === undefined) {
      missing.push(key);
      continue;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      missing.push(key);
      continue;
    }
    ratios.set(pipe, parsed);
  }
  if (missing.length > 0) warnings.push(`Missing AIV pipe metrics: ${missing.join(', ')}`);

  const efficiency = ratios.size ? Math.max(...ratios.values()) : null;

  return {
    scalar_rate: ratios.get('scalar') ?? null,
    vec_rate: ratios.get('vec') ?? null,
    mte2_rate: ratios.get('mte2') ?? null,
    mte3_rate: ratios.get('mte3') ?? null,
    efficiency_rate: efficiency,
    // Utilization percentages cannot establish absolute SOL; keep false to avoid unsupported stopping decisions.
    at_roofline: false,
    bottleneck: isTilingBound ? 'tiling' : classifyBottleneck(ratios, config),
    warnings,
    msprof_metrics: selectedMetrics,
  };
}
