/** Population deltas, attribution and confidence intervals between an epoch and its parent. */
import { type Lang, msg } from "./i18n.js";
import { round } from "./num.js";

export const MIN_TASKS = 20;
export const SUCCESS_EPS = 0.02;
const LATENCY_REL = 0.1;
const CI_Z = 1.959963984540054; // 95% two-sided

const DOMAIN_KEYS: Array<[string, string]> = [
  ["prompt_hash", "harness"],
  ["tools", "harness"],
  ["solver", "harness"],
  ["model", "model"],
  ["api", "model"],
  ["infra", "infra"],
  ["environment", "infra"],
  ["scheduler", "infra"],
  ["benchmark", "benchmark"],
  ["run", "benchmark"],
];

const NOTES: Record<Lang, Record<string, string>> = {
  en: {
    infra: "Only infra config changed this round; metric changes are attributed to the Infra Agent",
    harness: "Only harness (prompt/tools) changed this round; metric changes are attributed to the Harness Agent",
    model: "Only the model changed this round; metric changes are attributed to the model side",
    benchmark: "Only the benchmark/scope changed this round; metrics before and after are not comparable",
    mixed: "Multiple domains changed this round; metric changes cannot be attributed individually",
    none: "The fingerprint matches the parent; metric differences should be noise",
    hash: "The whole config changed but only an aggregate hash was reported, so prompt/tools/model/infra cannot be separated",
    unknown: "No fingerprint available, so attribution is unavailable",
  },
  zh: {
    infra: "本轮仅 infra 配置变更，指标变化归因于 Infra Agent",
    harness: "本轮仅 harness（prompt/tools）变更，指标变化归因于 Harness Agent",
    model: "本轮仅模型变更，指标变化归因于模型侧",
    benchmark: "本轮仅评测集/范围变更，前后指标不可直接比较",
    mixed: "本轮多个域同时变更，指标变化无法单独归因",
    none: "本轮 fingerprint 与父版本一致，指标差异应来自噪声",
    hash: "本轮配置整体已变更，但只上报了整体哈希，无法细分到 prompt/tools/model/infra",
    unknown: "缺少 fingerprint，无法归因",
  },
};

type Obj = Record<string, unknown>;
type Interval = [number, number];

interface StoreLike {
  findRunByCandidate(candidateId: string, excludeEpoch?: string | null): Obj | null;
}

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

// Prefer the structured config reported by the evaluator (manifest.configSummary),
// which resolves down to individual domains; legacy rows only carry a whole-config
// hash, where the only possible comparison is whether it changed.
function fingerprint(run: Obj | null | undefined): Obj {
  const record = asObject(run);
  let config: unknown = record.config;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config) as unknown;
    } catch {
      config = null;
    }
  }
  const configRecord = asObject(config);
  if (Object.keys(configRecord).length > 0) return configRecord;

  let fp: unknown = record.fingerprint;
  if (typeof fp === "string") {
    try {
      fp = JSON.parse(fp) as unknown;
    } catch {
      // Keep the raw string below.
    }
  }
  if (fp !== null && typeof fp === "object" && !Array.isArray(fp)) return fp as Obj;
  // When the client only reports a whole-config hash, all we can compare is whether it changed.
  if (typeof fp === "string" && fp) return { __config_hash__: fp };
  return {};
}

function diff(current: unknown, previous: unknown): number | null {
  if (!isNumber(current) || !isNumber(previous)) return null;
  return round(current - previous, 4);
}

/** Adaptive millisecond units: values like 2270415ms are unreadable as raw milliseconds. */
function fmtMs(value: unknown, signed = false): string {
  if (!isNumber(value)) return "—";
  const sign = signed && value > 0 ? "+" : "";
  if (Math.abs(value) < 1000) return `${sign}${value.toFixed(0)} ms`;
  if (Math.abs(value) < 60000) return `${sign}${(value / 1000).toFixed(1)} s`;
  return `${sign}${(value / 60000).toFixed(1)} min`;
}

function costPerTask(population: Obj): number | null {
  const cost = population.cost_usd;
  const tasks = Number(population.tasks ?? 0);
  if (!isNumber(cost) || tasks <= 0) return null;
  return round(cost / tasks, 6);
}

function attribution(currentRun: Obj | null, parentRun: Obj | null, lang: Lang): Obj {
  const notes = NOTES[lang];
  const current = fingerprint(currentRun);
  const previous = fingerprint(parentRun);
  if ("__config_hash__" in current && "__config_hash__" in previous) {
    const same = current.__config_hash__ === previous.__config_hash__;
    return {
      changed: same ? "none" : "hash",
      keys: same ? [] : ["config_hash"],
      unchanged: same ? ["config_hash"] : [],
      note: notes[same ? "none" : "hash"],
    };
  }
  if ("__config_hash__" in current || "__config_hash__" in previous) {
    return { changed: "hash", keys: [], unchanged: [], note: notes.hash };
  }
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [key] of DOMAIN_KEYS) {
    if (!(key in current) || !(key in previous)) continue;
    if (current[key] === previous[key]) unchanged.push(key);
    else changed.push(key);
  }
  const domains: string[] = [];
  for (const key of changed) {
    const domain = DOMAIN_KEYS.find(([name]) => name === key)?.[1];
    if (domain !== undefined && !domains.includes(domain)) domains.push(domain);
  }
  let changedDomain: string;
  if (Object.keys(current).length === 0 || Object.keys(previous).length === 0) changedDomain = "unknown";
  else if (domains.length === 0) changedDomain = "none";
  else if (domains.length === 1) changedDomain = domains[0]!;
  else changedDomain = "mixed";
  return { changed: changedDomain, keys: changed, unchanged, note: notes[changedDomain] };
}

/**
 * Wilson score interval: more stable than the normal approximation for small samples
 * or proportions near 0/1.
 */
function wilson(k: number, n: number, z = CI_Z): Interval | null {
  if (!n) return null;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const half = (z / denominator) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [round(center - half, 4), round(center + half, 4)];
}

/**
 * 95% interval for the difference of two proportions (p1-p2), Newcombe hybrid score.
 *
 * An interval spanning 0 means the two groups are statistically indistinguishable.
 * It is more robust than a plain z-test when proportions approach 0/1.
 */
function newcombe(k1: number, n1: number, k2: number, n2: number): Interval | null {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const w1 = wilson(k1, n1);
  const w2 = wilson(k2, n2);
  if (w1 === null || w2 === null) return null;
  const low = p1 - p2 - Math.sqrt((p1 - w1[0]) ** 2 + (w2[1] - p2) ** 2);
  const high = p1 - p2 + Math.sqrt((w1[1] - p1) ** 2 + (p2 - w2[0]) ** 2);
  return [round(low, 4), round(high, 4)];
}

/** success_rate is a rounded ratio; invert it back to success counts so proportion intervals apply. */
function counts(population: Obj): [number | null, number] {
  const rate = population.success_rate;
  const n = Number(population.tasks ?? 0);
  if (!isNumber(rate) || n <= 0) return [null, 0];
  return [Math.round(rate * n), n];
}

function successRateCi(currentPopulation: Obj, parentPopulation: Obj): Obj | null {
  const [k1, n1] = counts(currentPopulation);
  const [k2, n2] = counts(parentPopulation);
  const w1 = k1 === null ? null : wilson(k1, n1);
  const w2 = k2 === null ? null : wilson(k2, n2);
  if (w1 === null || w2 === null) return null;
  const difference = newcombe(k1 as number, n1, k2 as number, n2);
  return {
    confidence: 0.95,
    current: [...w1],
    parent: [...w2],
    diff: difference === null ? null : [...difference],
  };
}

function significant(current: Obj, parent: Obj, delta: Obj, ci: Obj | null): boolean {
  // Three gates: enough samples, enough effect size, and a confidence interval that
  // excludes 0. Point estimates alone would call a 2pp move on 20 samples significant
  // (standard error around +-11pp), and a false positive makes the verdict engine emit
  // accept -- its only path to a wrong release.
  if (Number(current.tasks ?? 0) < MIN_TASKS || Number(parent.tasks ?? 0) < MIN_TASKS) return false;
  const successRate = delta.success_rate;
  if (isNumber(successRate) && Math.abs(successRate) >= SUCCESS_EPS) {
    const interval = asObject(ci).diff as unknown;
    if (Array.isArray(interval) && (Number(interval[0]) > 0 || Number(interval[1]) < 0)) return true;
  }
  const p95 = delta.p95_latency_ms;
  const base = parent.p95_latency_ms;
  if (isNumber(p95) && isNumber(base) && base !== 0) return Math.abs(p95) / Math.abs(base) >= LATENCY_REL;
  return false;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPp(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}pp`;
}

function explain(current: Obj, parent: Obj, delta: Obj, parentEpoch: string, lang: Lang): string {
  const bits: string[] = [];
  const paren = (text: string): string => (lang === "zh" ? `（${text}）` : ` (${text})`);
  if (delta.success_rate !== null && delta.success_rate !== undefined) {
    bits.push(
      msg(
        lang,
        `success rate ${pct(Number(parent.success_rate))} → ${pct(Number(current.success_rate))}${paren(signedPp(Number(delta.success_rate) * 100))}`,
        `成功率 ${pct(Number(parent.success_rate))} → ${pct(Number(current.success_rate))}（${signedPp(Number(delta.success_rate) * 100)}）`,
      ),
    );
  }
  if (delta.p50_latency_ms !== null && delta.p50_latency_ms !== undefined) {
    bits.push(
      `P50 ${fmtMs(delta.p50_latency_ms, true)}${paren(`${fmtMs(parent.p50_latency_ms)} → ${fmtMs(current.p50_latency_ms)}`)}`,
    );
  }
  if (delta.p95_latency_ms !== null && delta.p95_latency_ms !== undefined) {
    bits.push(
      `P95 ${fmtMs(delta.p95_latency_ms, true)}${paren(`${fmtMs(parent.p95_latency_ms)} → ${fmtMs(current.p95_latency_ms)}`)}`,
    );
  }
  if (delta.cost_per_task !== null && delta.cost_per_task !== undefined) {
    bits.push(
      msg(
        lang,
        `cost per task $${Number(costPerTask(parent)).toFixed(4)} → $${Number(costPerTask(current)).toFixed(4)}`,
        `单任务成本 $${Number(costPerTask(parent)).toFixed(4)} → $${Number(costPerTask(current)).toFixed(4)}`,
      ),
    );
  }
  if (delta.steps_mean !== null && delta.steps_mean !== undefined) {
    bits.push(
      msg(
        lang,
        `mean steps ${Number(parent.steps_mean).toFixed(2)} → ${Number(current.steps_mean).toFixed(2)}`,
        `平均步数 ${Number(parent.steps_mean).toFixed(2)} → ${Number(current.steps_mean).toFixed(2)}`,
      ),
    );
  }
  const separator = lang === "zh" ? "，" : "; ";
  let text =
    bits.length > 0
      ? msg(
          lang,
          `vs parent ${parentEpoch}: ${bits.join(separator)}. `,
          `对比父版本 ${parentEpoch}：${bits.join(separator)}。`,
        )
      : msg(lang, `vs parent ${parentEpoch}: core metrics unchanged. `, `对比父版本 ${parentEpoch}：核心指标无变化。`);
  text += msg(lang, `${String(asObject(delta.attribution).note)}. `, `${String(asObject(delta.attribution).note)}。`);
  if (!delta.significant) {
    const bounds = asObject(delta.success_rate_ci).diff;
    if (Array.isArray(bounds) && Number(bounds[0]) <= 0 && Number(bounds[1]) >= 0) {
      text += msg(
        lang,
        `The 95% CI for the success-rate change [${signedPp(Number(bounds[0]) * 100)}, ${signedPp(Number(bounds[1]) * 100)}] crosses 0; `,
        `成功率变化 95% 区间 [${signedPp(Number(bounds[0]) * 100)}, ${signedPp(Number(bounds[1]) * 100)}] 跨 0；`,
      );
    }
    text += msg(
      lang,
      "the sample size or effect size is too small, so this conclusion is indicative only.",
      "样本量或变化幅度不足，结论仅供参考。",
    );
  }
  return text;
}

/** Resolve the parent epoch through runs.candidate_id. */
export function findParent(store: StoreLike | null, epoch: string, run: Obj | null): [string | null, Obj | null] {
  const parentId = asObject(run).parent_id;
  if (!parentId || store === null) return [null, null];
  const row = store.findRunByCandidate(String(parentId), epoch);
  if (!row) return [null, null];
  return [String(row.epoch), row];
}

export function computeDelta(
  currentRun: Obj | null,
  currentPopulation: Obj,
  parentRun: Obj | null,
  parentPopulation: Obj,
  parentEpoch: string,
  lang: Lang = "en",
): [Obj, string] {
  const delta: Obj = {
    parent_epoch: parentEpoch,
    success_rate: diff(currentPopulation.success_rate, parentPopulation.success_rate),
    p50_latency_ms: diff(currentPopulation.p50_latency_ms, parentPopulation.p50_latency_ms),
    p95_latency_ms: diff(currentPopulation.p95_latency_ms, parentPopulation.p95_latency_ms),
    cost_per_task: diff(costPerTask(currentPopulation), costPerTask(parentPopulation)),
    steps_mean: diff(currentPopulation.steps_mean, parentPopulation.steps_mean),
    samples: {
      current: currentPopulation.tasks ?? 0,
      parent: parentPopulation.tasks ?? 0,
    },
    // Absolute values ship alongside the delta so the verdict engine can write
    // "before -> after" without querying the parent epoch again.
    values: {
      current: {
        success_rate: currentPopulation.success_rate,
        p50_latency_ms: currentPopulation.p50_latency_ms,
        p95_latency_ms: currentPopulation.p95_latency_ms,
        cost_per_task: costPerTask(currentPopulation),
        steps_mean: currentPopulation.steps_mean,
      },
      parent: {
        success_rate: parentPopulation.success_rate,
        p50_latency_ms: parentPopulation.p50_latency_ms,
        p95_latency_ms: parentPopulation.p95_latency_ms,
        cost_per_task: costPerTask(parentPopulation),
        steps_mean: parentPopulation.steps_mean,
      },
    },
    attribution: attribution(currentRun, parentRun, lang),
  };
  delta.success_rate_ci = successRateCi(currentPopulation, parentPopulation);
  delta.significant = significant(currentPopulation, parentPopulation, delta, asObject(delta.success_rate_ci));
  return [delta, explain(currentPopulation, parentPopulation, delta, parentEpoch, lang)];
}
