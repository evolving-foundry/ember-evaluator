import { fileURLToPath } from "node:url";
import { expectRecord, expectNonEmptyString, expectPositiveInteger, rejectUnknown } from "../core/validation/input.js";

const LOCAL_JOBS_ENDPOINT = "https://localhost:9443";
const LOCAL_JOBS_CA_FILE = fileURLToPath(new URL("../../.scratch/ray-smoke/security/cert.pem", import.meta.url));

export type JobsConfig = {
  transport: "jobs";
  endpoint: string;
  caFile: string;
  tokenEnv: string;
  concurrency?: number;
  nodes?: number;
  managedLocal?: boolean;
};
export function parseJobsConfig(value: unknown): JobsConfig {
  const c = expectRecord(value, "Ray Jobs config");
  rejectUnknown(c, ["transport", "endpoint", "caFile", "tokenEnv", "concurrency", "nodes", "managedLocal"], "Ray Jobs config");
  if (c.transport !== undefined && c.transport !== "jobs") throw new TypeError("Ray Jobs transport must be jobs");
  const endpoint = expectNonEmptyString(c.endpoint ?? LOCAL_JOBS_ENDPOINT, "Ray Jobs endpoint");
  const u = new URL(endpoint);
  if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash)
    throw new TypeError("Ray Jobs endpoint must be an HTTPS origin");
  const tokenEnv = expectNonEmptyString(c.tokenEnv ?? "EVALUATOR_JOBS_TOKEN", "Jobs tokenEnv");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnv)) throw new TypeError("Invalid Jobs tokenEnv");
  if (c.managedLocal !== undefined && typeof c.managedLocal !== "boolean")
    throw new TypeError("Jobs managedLocal must be a boolean");
  if (c.managedLocal && u.origin !== LOCAL_JOBS_ENDPOINT)
    throw new TypeError("Jobs managedLocal requires https://localhost:9443");
  return {
    transport: "jobs",
    endpoint: u.origin,
    caFile: expectNonEmptyString(
      c.caFile ?? (u.origin === LOCAL_JOBS_ENDPOINT ? LOCAL_JOBS_CA_FILE : undefined),
      "Jobs caFile",
    ),
    tokenEnv,
    ...(c.nodes === undefined ? {} : { nodes: expectPositiveInteger(c.nodes, "Jobs nodes") }),
    ...(c.concurrency === undefined ? {} : { concurrency: expectPositiveInteger(c.concurrency, "Jobs concurrency") }),
    ...(c.managedLocal === undefined ? {} : { managedLocal: c.managedLocal }),
  };
}
