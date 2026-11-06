import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { retryRun } from "../../../../dist/application/retry.js";
import { createJobsProgressPublisher } from "../../../../dist/infrastructure/ray/jobs-progress.js";
const [jobId, runId, requestId] = process.argv.slice(2);
if (![jobId, runId].every(value => /^[0-9a-f-]{36}$/u.test(value ?? "")) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(requestId ?? "")) throw new Error("Invalid recovery identity");
const directory = join(process.env.EVALUATOR_JOBS_ROOT ?? "/jobs", jobId);
process.env.EVALUATOR_RETRY_SOCKET_DIR = directory;
const runRoot = join(directory, "results", runId);
const authPath = join(directory, `retry-auth-${requestId}.json`);
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
const variables = [];
let progress;
try {
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  await rm(authPath);
  const config = JSON.parse(await readFile(join(runRoot, "config.yaml"), "utf8"));
  const required = new Set([config.solver.service, config.verifier?.service, config.benchmark.config?.judgeService]);
  for (const [name, service] of Object.entries(config.services)) {
    if (!required.has(name)) continue;
    const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(service.apiKey ?? "")?.[1];
    if (!variable || typeof auth[name] !== "string" || !auth[name]) throw new Error("Original service authentication unavailable");
    process.env[variable] = auth[name]; variables.push(variable);
  }
  const security = process.env.EVALUATOR_JOBS_SECURITY ?? "/security";
  process.env.EVALUATOR_TRANSFER_TOKEN = (await readFile(join(security, "token"), "utf8")).trim();
  const control = JSON.parse(await readFile(join(runRoot, "retry-control.json"), "utf8"));
  const request = control.requests.find(item => item.requestId === requestId);
  if (!request) throw new Error("Recovery request missing");
  progress = await createJobsProgressPublisher(jobId, Object.values(auth));
  process.exitCode = await retryRun({ run: runRoot, requestId, taskIds: request.taskIds }, controller.signal,
    text => process.stdout.write(text + "\n"), event => progress?.observe(event));
} finally {
  await progress?.close();
  for (const variable of variables) delete process.env[variable];
  delete process.env.EVALUATOR_TRANSFER_TOKEN;
  await rm(authPath, { force: true });
}
