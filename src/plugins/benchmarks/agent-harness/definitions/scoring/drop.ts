import type { VerifyResult } from "../../../../../core/contracts/result.js";

function numeric(token: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token) && Number.isFinite(Number(token));
}

function normalize(span: string): string {
  return span.toLowerCase().split(/[ -]/).map(token => {
    const clean = numeric(token) ? token : token.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "");
    return numeric(clean) ? String(Number(clean)) : clean.replace(/(?<![\p{L}\p{N}_])(a|an|the)(?![\p{L}\p{N}_])/gu, " ");
  }).join(" ").trim().replace(/\s+/g, " ");
}

function spanF1(predicted: string, gold: string): number {
  const a = new Set(predicted.split(" ").filter(Boolean));
  const b = new Set(gold.split(" ").filter(Boolean));
  const numbers = [...b].filter(numeric);
  if (numbers.length && !numbers.some(number => a.has(number))) return 0;
  const overlap = [...a].filter(token => b.has(token)).length;
  const precision = a.size ? overlap / a.size : 1;
  const recall = b.size ? overlap / b.size : 1;
  return precision || recall ? 2 * precision * recall / (precision + recall) : 0;
}

/** CPython round(value, 2): round the exact binary float, with ties to even. */
function roundF1(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const significand = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1023 - 52;
  if (shift >= 0) return value;
  const numerator = significand * 100n, denominator = 1n << BigInt(-shift);
  const whole = numerator / denominator, remainder = numerator % denominator;
  const up = remainder * 2n > denominator || (remainder * 2n === denominator && whole % 2n === 1n);
  return Number(whole + (up ? 1n : 0n)) / 100;
}

/** Maximum one-to-one span alignment using the Hungarian assignment algorithm. */
function alignedF1(predicted: string[], gold: string[]): number {
  const n = Math.max(predicted.length, gold.length);
  if (!n) return 0;
  // Padding represents an unmatched span, not an actual empty-string answer.
  const weight = (i: number, j: number) => i < predicted.length && j < gold.length ? spanF1(predicted[i] ?? "", gold[j] ?? "") : 0;
  const u = Array<number>(n + 1).fill(0), v = [...u], matching = [...u], previous = [...u];
  for (let row = 1; row <= n; row++) {
    matching[0] = row;
    let column = 0;
    const minimum = Array<number>(n + 1).fill(Infinity), used = Array<boolean>(n + 1).fill(false);
    do {
      used[column] = true;
      const current = matching[column] ?? 0;
      let delta = Infinity, next = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cost = 1 - weight(current - 1, j - 1) - (u[current] ?? 0) - (v[j] ?? 0);
        if (cost < (minimum[j] ?? Infinity)) { minimum[j] = cost; previous[j] = column; }
        if ((minimum[j] ?? Infinity) < delta) { delta = minimum[j] ?? Infinity; next = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { const i = matching[j] ?? 0; u[i] = (u[i] ?? 0) + delta; v[j] = (v[j] ?? 0) - delta; }
        else minimum[j] = (minimum[j] ?? Infinity) - delta;
      }
      column = next;
    } while (matching[column]);
    do { const next = previous[column] ?? 0; matching[column] = matching[next] ?? 0; column = next; } while (column);
  }
  const sum = matching.slice(1).reduce((total, row, index) => total + weight(row - 1, index), 0);
  return roundF1(sum / n);
}

export function scoreDrop(answers: string[], response: string): VerifyResult {
  const extracted = [...response.matchAll(/^\s*Answer\s*:\s*(.*)$/gim)].at(-1)?.[1]?.trim() ?? response.trim();
  let predicted = [extracted];
  if (extracted.startsWith("[")) {
    try {
      const spans: unknown = JSON.parse(extracted);
      if (Array.isArray(spans) && spans.every((span): span is string => typeof span === "string")) predicted = spans;
    } catch { /* Malformed answers receive no structural shortcut. */ }
  }
  const gold = answers.map(normalize), actual = predicted.map(normalize);
  const valid = answers.length > 0 && (answers[0] ?? "").trim() !== "";
  const exactMatch = valid && gold.length === actual.length && new Set(gold).size === new Set(actual).size && gold.every(span => actual.includes(span));
  const f1 = valid ? alignedF1(actual, gold) : 0;
  return { score: f1, passed: exactMatch, details: { protocol: "drop-official-annotations-v1", version: 1,
    officialComparable: false, reference: "https://github.com/allenai/allennlp-models/blob/b1f372248c17ad12684d344955fbcd98e957e77e/allennlp_models/rc/tools/drop.py", extracted, exactMatch, f1 } };
}

/** Different annotators are alternatives; alignment applies within each answer. */
export function scoreDropCandidates(candidates: string[][], response: string): VerifyResult {
  if (!candidates.length) throw new TypeError("DROP requires reference candidates");
  const scores = candidates.map(candidate => scoreDrop(candidate, response));
  const score = Math.max(...scores.map(result => result.score ?? 0));
  const passed = scores.some(result => result.passed === true);
  const best = scores.find(result => result.score === score);
  if (!best || best.details === null || typeof best.details !== "object" || Array.isArray(best.details))
    throw new Error("Missing DROP score evidence");
  return { score, passed, details: { ...best.details, exactMatch: passed, f1: score, candidateCount: candidates.length } };
}
