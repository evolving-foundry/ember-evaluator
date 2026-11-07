import { expectRecord, rejectUnknown, expectNonEmptyString, expectPositiveInteger } from "../core/validation/input.js";

export type RaySchedulerConfig = {
  endpoint: string;
  concurrency?: number;
  nodes?: number;
  pythonExecutable: string;
  startupTimeoutMs: number;
  heartbeatTimeoutMs: number;
  cancelGraceMs: number;
  collector: { certFile: string; keyFile: string; tokenEnv: string; host: string; port: number; publicUrl?: string };
};
export function parseRayConfig(value: unknown): RaySchedulerConfig {
  const config = expectRecord(value, "ray scheduler");
  rejectUnknown(
    config,
    [
      "endpoint",
      "concurrency",
      "nodes",
      "pythonExecutable",
      "startupTimeoutMs",
      "heartbeatTimeoutMs",
      "cancelGraceMs",
      "collector",
    ],
    "ray scheduler",
  );
  const endpoint = expectNonEmptyString(config.endpoint, "Ray endpoint");
  if (endpoint !== "local" && endpoint !== "auto") {
    const url = new URL(endpoint);
    if (
      url.protocol !== "ray:" ||
      !url.hostname ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== "/")
    )
      throw new TypeError("Ray endpoint must use ray://host:port");
  }
  const collector = expectRecord(config.collector, "Ray collector");
  rejectUnknown(collector, ["certFile", "keyFile", "tokenEnv", "host", "port", "publicUrl"], "Ray collector");
  const tokenEnv = collector.tokenEnv ?? "EVALUATOR_TRANSFER_TOKEN";
  if (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnv))
    throw new TypeError("Invalid Ray collector token environment variable");
  const port = collector.port ?? 0;
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535)
    throw new TypeError("Invalid Ray collector port");
  let publicUrl: string | undefined;
  if (collector.publicUrl !== undefined) {
    publicUrl = expectNonEmptyString(collector.publicUrl, "Ray collector publicUrl");
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new TypeError("Ray collector publicUrl must be an HTTPS origin");
  } else if (endpoint !== "local")
    throw new TypeError("Remote Ray clusters require a node-reachable collector publicUrl");
  const positive = (name: string, fallback: number) => expectPositiveInteger(config[name] ?? fallback, `Ray ${name}`);
  return {
    endpoint,
    ...(config.nodes === undefined ? {} : { nodes: expectPositiveInteger(config.nodes, "Ray nodes") }),
    ...(config.concurrency === undefined
      ? {}
      : { concurrency: expectPositiveInteger(config.concurrency, "Ray concurrency") }),
    pythonExecutable: expectNonEmptyString(config.pythonExecutable ?? "python", "Ray pythonExecutable"),
    startupTimeoutMs: positive("startupTimeoutMs", 120000),
    heartbeatTimeoutMs: positive("heartbeatTimeoutMs", 120000),
    cancelGraceMs: positive("cancelGraceMs", 90000),
    collector: {
      certFile: expectNonEmptyString(collector.certFile, "Ray certFile"),
      keyFile: expectNonEmptyString(collector.keyFile, "Ray keyFile"),
      tokenEnv,
      host: expectNonEmptyString(collector.host ?? "127.0.0.1", "Ray collector host"),
      port: port as number,
      ...(publicUrl ? { publicUrl } : {}),
    },
  };
}
