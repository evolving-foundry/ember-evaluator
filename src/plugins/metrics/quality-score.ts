import type { Metrics } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import { evaluationScore, isEvaluationComplete } from "../../core/results/evaluation-outcome.js";
import { selectedRecords } from "./records.js";

/** Continuous scores and categorical judge evidence use measured samples only. */
export class QualityScoreMetrics implements Metrics {
  readonly name = "quality-score";
  async compute(snapshot: ResultSnapshot) {
    const records = selectedRecords(snapshot).filter(isEvaluationComplete);
    const scores = records.flatMap(record => { const score = evaluationScore(record); return score === undefined ? [] : [score]; });
    const categories = { CORRECT: 0, INCORRECT: 0, NOT_ATTEMPTED: 0 };
    const triviaScores: { exactMatch: number; f1: number }[] = [];
    const protocols = new Set<string>();
    for (const record of records) {
      const details = record.verdict?.details;
      if (details && typeof details === "object" && !Array.isArray(details)) {
        if (typeof details.protocol === "string") protocols.add(details.protocol);
        if (details.grade === "CORRECT" || details.grade === "INCORRECT" || details.grade === "NOT_ATTEMPTED") categories[details.grade]++;
        if (details.method === "trivia" && typeof details.exactMatch === "boolean" && typeof details.f1 === "number")
          triviaScores.push({ exactMatch: details.exactMatch ? 1 : 0, f1: details.f1 });
      }
    }
    const rawMean = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null;
    const mean = [...protocols].some(protocol => protocol.startsWith("healthbench-")) && rawMean !== null ? Math.max(0, Math.min(1, rawMean)) : rawMean;
    const total = categories.CORRECT + categories.INCORRECT + categories.NOT_ATTEMPTED;
    const attempted = categories.CORRECT + categories.INCORRECT;
    const accuracy = attempted ? categories.CORRECT / attempted : total ? 0 : null;
    const correctRate = total ? categories.CORRECT / total : null;
    return { applicable: snapshot.run.evaluationKind !== "performance", measured: scores.length, mean, rawMean,
      protocols: [...protocols], officialComparable: false,
      triviaqa: triviaScores.length ? { measured: triviaScores.length,
        exactMatch: triviaScores.reduce((sum, result) => sum + result.exactMatch, 0) / triviaScores.length,
        f1: triviaScores.reduce((sum, result) => sum + result.f1, 0) / triviaScores.length } : null,
      simpleqa: total ? { ...categories, correctRate, incorrectRate: categories.INCORRECT / total,
        notAttemptedRate: categories.NOT_ATTEMPTED / total, accuracyGivenAttempted: accuracy,
        f1: accuracy !== null && correctRate !== null && accuracy + correctRate ? 2 * accuracy * correctRate / (accuracy + correctRate) : 0 } : null };
  }
}
