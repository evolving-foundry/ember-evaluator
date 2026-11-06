import type { PreparedTask, JsonValue } from "../../../../../core/contracts/task.js";
import type { AttemptStepResult } from "../../../../../core/contracts/result.js";
import type { HarborConfig } from "./config.js";
import { scoreHarborEvidence } from "./verify.js";

function rewards(value: JsonValue): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value.rewards;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

export function evaluateHarborSteps(task: PreparedTask, results: AttemptStepResult[], scoring: HarborConfig["scoring"]) {
  const last = results.at(-1);
  if (!last) return { verdict: null, continue: false };
  const step = task.steps?.[results.length - 1];
  const thresholds = typeof step?.minReward === "number" ? { reward: step.minReward } : step?.minReward ?? {};
  const latest = last.verdict ? rewards(last.verdict.details) : {};
  const proceed = last.verdict !== null &&
    Object.entries(thresholds).every(([key, threshold]) => (latest[key] ?? -Infinity) >= threshold);
  const envelope = task.verification;
  const final = envelope && typeof envelope === "object" && !Array.isArray(envelope) && envelope.stepRewardStrategy === "final";
  const valid = results.flatMap(result => result.verdict ? [rewards(result.verdict.details)] : []);
  if (!valid.length) return { verdict: null, continue: false };
  const combined = final ? latest : Object.fromEntries([...new Set(valid.flatMap(value => Object.keys(value)))].map(key =>
    [key, valid.reduce((sum, value) => sum + (value[key] ?? 0), 0) / valid.length]));
  const verdict = final && !last.verdict ? null : scoreHarborEvidence({ rewards: combined,
    details: { scoring: "task-native-multistep", strategy: final ? "final" : "mean", executedSteps: results.map(result => result.name) } }, scoring);
  return { verdict, continue: proceed };
}
