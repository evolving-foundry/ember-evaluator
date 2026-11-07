import { readFile, writeFile, mkdir, rm, access, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { executeExperiment } from "../../../../dist/application/run.js";
import { executeWarmup } from "../../../../dist/application/warmup.js";
import { cleanupImages } from "../../../../dist/application/cleanup.js";
import { createJobsProgressPublisher } from "../../../../dist/infrastructure/ray/jobs-progress.js";
import { loadSavedConfig } from "../../../../dist/application/config.js";
import { openPluginRegistry } from "../../../../dist/application/plugins/open-registry.js";
import { assertWorkerVersions, localizePortableSelection } from "../../../../dist/infrastructure/ray/protocol.js";
import { PACKAGE_RUNTIME_ID } from "../../../../dist/core/results/runtime-identity.js";
import { resolvePluginPatchPath } from "../../../../dist/infrastructure/ray/node-config.js";

const id = process.argv[2];
if (!/^[0-9a-f-]{36}$/u.test(id ?? "")) throw new Error("Invalid job ID");
const dir = join(process.env.EVALUATOR_JOBS_ROOT ?? "/jobs", id);
// The gateway and coordinator share this short directory, including the Unix Socket.
process.env.EVALUATOR_RETRY_SOCKET_DIR = dir;
const security = process.env.EVALUATOR_JOBS_SECURITY ?? "/security";
const inputPath = join(dir, "input.json");
const controller = new AbortController();
let progress;
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
const timer = setInterval(() => {
  access(join(dir, "cancel")).then(
    () => controller.abort(),
    () => {},
  );
}, 500);
let configPath;
let registry;
const credentials = [];
const serviceVariables = [];
const patchSetting = process.env.EVALUATOR_PLUGIN_PATCH_PATH;
const pluginPatchPath = resolvePluginPatchPath(patchSetting, process.cwd());
try {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  if (input.operation !== undefined && !["run", "warmup", "cleanup-images"].includes(input.operation)) throw new Error("Invalid job operation");
  const maintenance = input.operation === "cleanup-images";
  if (maintenance && (!input.cleanup || typeof input.cleanup.all !== "boolean" || typeof input.cleanup.execute !== "boolean" || Object.keys(input.cleanup).some(key => !["all", "execute"].includes(key)))) throw new Error("Invalid image cleanup options");
  const warmup = input.operation === "warmup" || maintenance;
  if (warmup && (input.seed !== undefined || input.resumeRunId !== undefined || input.requestedRunId !== undefined))
    throw new Error("Warmup cannot resume an evaluation run");
  if (Object.hasOwn(input, "auth") || !input.serviceAuth || typeof input.serviceAuth !== "object" || Array.isArray(input.serviceAuth)) throw new Error("Invalid service credentials");
  if (warmup && Object.keys(input.serviceAuth).length) throw new Error("Warmup does not accept model credentials");
  credentials.push(...Object.values(input.serviceAuth).filter(value => typeof value === "string" && value));
  try {
    await access(join(dir, "cancel"));
    controller.abort();
  } catch {
    /* Not cancelled. */
  }
  const config = input.config;
  const scheduling = config.scheduler.config;

  process.env.EVALUATOR_TRANSFER_TOKEN = (await readFile(join(security, "token"), "utf8")).trim();
  const service = config.services?.[config.solver?.service];
  if (!service) throw new Error("Submitted experiment has no solver service");
  if (!warmup && !Object.hasOwn(input.serviceAuth, config.solver.service)) throw new Error("Solver service credential is required");
  for (const [index, [name, value]] of Object.entries(input.serviceAuth).entries()) {
    const selected = config.services?.[name];
    if (!selected || typeof value !== "string" || !value) throw new Error("Invalid service credential");
    const variable = `EVALUATOR_JOB_SERVICE_KEY_${index}`;
    process.env[variable] = value;
    serviceVariables.push(variable);
    selected.apiKeyEnv = variable;
    delete selected.apiKey;
  }
  registry = await openPluginRegistry(pluginPatchPath);
  assertWorkerVersions(input.pluginVersions, registry.pluginVersions,
    input.pluginVersions[PACKAGE_RUNTIME_ID], registry.pluginVersions[PACKAGE_RUNTIME_ID]);
  const lookup = (role, name) => registry.ctx.evaluator.configTransport(role, name);
  const host = { outputRoot: process.env.EVALUATOR_JOBS_ROOT ?? "/jobs" };
  for (const role of ["benchmark", "environment", "solver", "verifier", "store", "reporter"])
    if (config[role] !== undefined) config[role] = localizePortableSelection(config[role], role, host, lookup);
  if (Array.isArray(config.metrics)) config.metrics = config.metrics.map(item => localizePortableSelection(item, "metrics", host, lookup));
  config.output = { directory: join(dir, "results") };
  // Resume recovery: materialize the seeded run metadata before the engine opens it.
  const resumeRunId = typeof input.resumeRunId === "string" ? input.resumeRunId : null;
  if (resumeRunId !== null || input.seed !== undefined) {
    if (
      resumeRunId === null ||
      !/^[0-9a-f-]{36}$/u.test(resumeRunId) ||
      input.seed === null ||
      typeof input.seed !== "object"
    ) {
      throw new Error("Invalid resume submission");
    }
    const resultsRoot = join(dir, "results", resumeRunId);
    for (const [relative, content] of Object.entries(input.seed)) {
      if (
        typeof content !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(relative)
      ) {
        throw new Error("Unsafe seed path");
      }
      const target = join(resultsRoot, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: "utf8", flag: "wx" });
    }
  }
  config.scheduler = {
    name: "ray",
    config: {
      endpoint: "auto",
      pythonExecutable: "/usr/local/bin/python",
      ...(scheduling.concurrency === undefined ? {} : { concurrency: scheduling.concurrency }),
      ...(scheduling.nodes === undefined ? {} : { nodes: scheduling.nodes }),
      collector: {
        host: "0.0.0.0",
        port: 0,
        publicUrl: process.env.EVALUATOR_COLLECTOR_ORIGIN ?? "https://head",
        certFile: join(security, "cert.pem"),
        keyFile: join(security, "key.pem"),
        tokenEnv: "EVALUATOR_TRANSFER_TOKEN",
      },
    },
  };
  // Only deployment-installed plugins are loaded. No client paths or uploaded code.
  const configDirectory = process.env.EVALUATOR_WORKER_PROFILE === "builtin" ? "/builtin-experiment" : "/experiment";
  await mkdir(configDirectory, { recursive: true });
  configPath = join(configDirectory, `job-${id}.json`);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
  const loaded = await loadSavedConfig(configPath, process.env, { registry, allowMissingAuth: warmup });
  progress = await createJobsProgressPublisher(id, credentials);
  let warmupSummary;
  const execution = { config: loaded, registry, ...(input.requestedRunId === undefined ? {} : { runId: input.requestedRunId }) };
  const options = { configPath, signal: controller.signal, execution,
    ...(pluginPatchPath === undefined ? {} : { patchPath: pluginPatchPath }),
    onProgress: event => progress?.observe(event) };
  if (maintenance) {
    warmupSummary = await cleanupImages({ file: configPath, ...input.cleanup, ...options });
    process.exitCode = controller.signal.aborted ? 130 : warmupSummary.nodes.some(node => node.error || node.items.some(item => item.status === "failed")) ? 1 : 0;
  } else if (warmup) {
    warmupSummary = await executeWarmup(options);
    process.exitCode = warmupSummary.status === "ready" ? 0 : 1;
  } else {
    const outcome = await executeExperiment({ ...options, ...(resumeRunId === null ? {} : { resume: resumeRunId }),
      onDeploymentLog: text => process.stdout.write(text + "\n"),
      onDiagnostic: diagnostic => process.stderr.write(credentials.reduce((text, value) => text.replaceAll(value, "[redacted]"), String(diagnostic.error)) + "\n") });
    process.exitCode = outcome.exitCode;
    if (outcome.result?.kind === "local" && !outcome.diagnostics.length) process.stdout.write(outcome.result.runDirectory + "\n");
  }
  if (warmup && warmupSummary) {
    const summaryFile = maintenance ? "image-cleanup.json" : "warmup.json";
    await writeFile(join(dir, `${summaryFile}.tmp`), JSON.stringify(warmupSummary) + "\n", { mode: 0o600, flag: "wx" });
    await rename(join(dir, `${summaryFile}.tmp`), join(dir, summaryFile));
  }
} catch (error) {
  // Never print the staged input or raw credential-bearing configuration.
  console.error(
    "Cluster coordinator failed:",
    credentials.reduce((message, value) => message.replaceAll(value, "[redacted]"), String(error.message)),
  );
  process.exitCode = 1;
} finally {
  await progress?.close();
  clearInterval(timer);
  await registry?.dispose();
  for (const variable of serviceVariables) delete process.env[variable];
  await rm(inputPath, { force: true });
  if (configPath) await rm(configPath, { force: true });
}
