import { execFile } from "node:child_process";
import { access, readFile, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createConnection } from "node:net";
import { connect } from "node:tls";
import { promisify } from "node:util";
import type { LoadedConfig } from "../../config/loaded.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { JobsClient } from "../../infrastructure/ray/jobs-client.js";
import { parseJobsConfig } from "../../config/jobs.js";
import { resolveAgentXPython } from "../../runtimes/agentx/runtime.js";
import { checkHostTelemetry } from "../../runtimes/agentx/host-telemetry.js";
import { parseTelemetryConfig } from "../../plugins/benchmarks/inference-engine/agentx/evidence/telemetry.js";

type Check = { name: string; status: "passed" | "failed" | "not-checked"; detail: string };
const execute = promisify(execFile);

export async function diagnose(config: LoadedConfig, file: string, signal: AbortSignal): Promise<Check[]> {
  const checks: Check[] = [{ name: "configuration", status: "passed", detail: "Configuration, credential variables, plugins and component combinations validated" }];
  const directory = dirname(resolve(file));
  const secrets = Object.values(config.auths).map(auth => auth.value);
  const check = async (name: string, run: () => Promise<unknown>) => {
    try { await run(); checks.push({ name, status: "passed", detail: "Available" }); }
    catch (error) { checks.push({ name, status: "failed", detail: redactDiagnostic(error instanceof Error ? error.message : String(error), secrets) }); }
  };
  const executable = (name: string, args: string[]) => check(name, () => execute(name, args, { signal, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }));
  if (config.deployment) {
    const { kind: _kind, ...connection } = config.deployment;
    await check("Ray Jobs credential and CA", () => JobsClient.create(parseJobsConfig(connection), path => resolve(directory, path), Object.values(config.auths).map(auth => auth.value)));
    await check("Ray Jobs TLS", async () => {
      const url = new URL(config.deployment?.endpoint ?? "");
      const ca = await readFile(resolve(directory, connection.caFile));
      await new Promise<void>((resolveCheck, reject) => {
        const socket = connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, ca, rejectUnauthorized: true });
        const abort = () => socket.destroy(new Error("Diagnostic cancelled", { cause: signal.reason }));
        signal.addEventListener("abort", abort, { once: true });
        socket.once("close", () => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
        socket.setTimeout(5000, () => socket.destroy(new Error("Ray Jobs TLS timeout")));
        socket.once("secureConnect", () => { socket.destroy(); resolveCheck(); });
        socket.once("error", reject);
      });
    });
    checks.push({ name: "execution nodes", status: "not-checked", detail: "Verify remote Python, Docker, plugin deployment and model permissions on the execution nodes" });
  } else {
    const env = config.experiment.environment;
    if (env.name === "docker" && config.experiment.scheduler.name !== "ray") await executable(String(env.config.dockerExecutable ?? "docker"), ["version", "--format", "{{.Server.Version}}"]);
    if (config.experiment.solver.name === "agentx-replay" && env.name === "local")
      await check("AgentX Python", () => resolveAgentXPython(
        typeof config.experiment.solver.config.pythonExecutable === "string" ? config.experiment.solver.config.pythonExecutable : undefined, signal));
    if (config.experiment.solver.name === "agentx-replay" && ["local", "docker"].includes(env.name) && config.experiment.solver.config.telemetry !== undefined) {
      const ascend = parseTelemetryConfig(config.experiment.solver.config.telemetry, config.experiment.hardware).ascend;
      if (ascend && "mode" in ascend) await check("NPU host sampling control (no device queries)", () => checkHostTelemetry(signal,
        env.name === "local" && typeof config.experiment.solver.config.pythonExecutable === "string" ? config.experiment.solver.config.pythonExecutable : undefined));
    }
    if (config.experiment.scheduler.name === "ray") {
      await executable(String(config.experiment.scheduler.config.pythonExecutable ?? "python"), ["-c", "import ray; print(ray.__version__)"]);
      const collector = config.experiment.scheduler.config.collector;
      if (collector && typeof collector === "object") {
        for (const [field, path] of Object.entries(collector)) {
          if ((field === "certFile" || field === "keyFile") && typeof path === "string") {
            await check(`collector ${field}`, () => access(resolve(directory, path)));
          }
        }
      }
      checks.push({ name: "execution nodes", status: "not-checked", detail: "Verify remote Docker, runtimes and plugins on the execution nodes" });
      const endpoint = config.experiment.scheduler.config.endpoint;
      if (typeof endpoint === "string" && endpoint.startsWith("ray://")) await check("Ray TCP", async () => {
        const url = new URL(endpoint);
        await new Promise<void>((resolveCheck, reject) => {
          const socket = createConnection({ host: url.hostname, port: Number(url.port), signal });
          socket.setTimeout(5000, () => socket.destroy(new Error("Ray TCP timeout")));
          socket.once("connect", () => { socket.destroy(); resolveCheck(); }); socket.once("error", reject);
        });
      });
      else checks.push({ name: "Ray cluster", status: "not-checked", detail: "auto/local clusters are not started during diagnostics" });
    }
    const solver = config.experiment.solver;
    const bundlePath = solver.config.path;
    if (config.experiment.scheduler.name !== "ray" && solver.name === "agentbundle" && typeof bundlePath === "string") await check("AgentBundle path", () => access(resolve(directory, bundlePath)));
    const source = config.experiment.benchmark.config.source;
    const localPath = config.experiment.benchmark.config.localPath;
    if (typeof localPath === "string") await check("local dataset", async () => {
      const info = await lstat(resolve(directory, localPath));
      if (!info.isFile() && !info.isDirectory()) throw new Error("localPath must be a regular file or directory");
    });
    if (source && typeof source === "object" && "kind" in source && source.kind === "local" && "path" in source && typeof source.path === "string") {
      const path = source.path;
      await check("local source", () => access(resolve(directory, path)));
    }
  }
  checks.push({ name: "model and task execution", status: "not-checked", detail: "Model calls and real tasks are not executed. Separate network probes check downloads; run warmup to validate the selected task data and images." });
  return checks;
}
