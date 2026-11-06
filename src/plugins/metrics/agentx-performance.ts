import type { Metrics } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { parseAgentXSummary } from "../benchmarks/inference-engine/agentx/evidence/summary.js";
import { selectedRecords } from "./records.js";
import { attemptStatus, isEvaluationComplete } from "../../core/results/evaluation-outcome.js";

export class AgentXPerformanceMetrics implements Metrics {
  readonly name = "agentx-performance";
  async compute(snapshot: ResultSnapshot): Promise<JsonValue> {
    const records = selectedRecords(snapshot);
    if (snapshot.run.evaluationKind !== "performance") return { applicable: false, points: [] };
    const source = snapshot.run.source;
    if (!source) return { applicable: true, taskSetKnown: false, points: [] };
    const byTask = new Map(records.map(record => [record.key.taskId, record]));
    const points = snapshot.run.taskIds.map(taskId => {
      const record = byTask.get(taskId);
      const summary = record && isEvaluationComplete(record) ? parseAgentXSummary(record.solve?.observations) : null;
      if (summary && (summary.workload.revision !== source.revision ||
        source.files.find(file => file.path === "traces.jsonl")?.sha256 !== summary.workload.sha256))
        throw new TypeError("AgentX summary differs from the run source lock");
      return { taskId, status: record ? attemptStatus(record) : "pending", measurement: summary };
    });
    return { applicable: true, points };
  }
}
