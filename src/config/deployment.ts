import { parseJobsConfig, type JobsConfig } from "./jobs.js";
import { expectRecord, rejectUnknown } from "../core/validation/input.js";

export type Deployment = { kind: "ray-jobs" } & Omit<JobsConfig, "concurrency" | "nodes" | "transport">;

export function parseDeployment(value: unknown): Deployment {
  const record = expectRecord(value, "deployment");
  rejectUnknown(record, ["kind", "endpoint", "caFile", "tokenEnv", "managedLocal"], "deployment");
  if (record.kind !== "ray-jobs") throw new TypeError("deployment.kind must be ray-jobs");
  const { kind: _kind, ...connection } = record;
  const { transport: _transport, concurrency: _concurrency, nodes: _nodes, ...config } = parseJobsConfig(connection);
  return { kind: "ray-jobs", ...config, managedLocal: config.managedLocal ?? false };
}
