import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";
import { safeTaskKey } from "../../dist/core/artifacts/artifacts.js";

process.env.EVALUATOR_JOBS_TOKEN = (await readFile("/security/jobs-token", "utf8")).trim();
process.env.EVALUATOR_SMOKE_MODEL_KEY = "smoke-only-not-a-model-key";
const file = "/experiment/jobs-controlled.json";
const output = `/results/jobs-controlled-${Date.now()}`;
const config = {
  services: { default: { model: "fixture", base_url: "https://fixture.invalid/v1", api: "openai-completions", api_key: "${EVALUATOR_SMOKE_MODEL_KEY}" } },
  benchmark: { name: "ray-fixture", solver: { name: "ray-fixture", service: "default" } }, environment: "local",
  deployment: { kind: "ray-jobs", endpoint: "https://gateway:9443", caFile: "/security/cert.pem", tokenEnv: "EVALUATOR_JOBS_TOKEN" },
  scheduler: { name: "ray", concurrency: 2 },
  metrics: [{ name: "success-rate" }, { name: "duration" }], run: { maxTasks: 2, timeoutSeconds: 120 }, output: { directory: output },
};
await writeFile(file, JSON.stringify(config));
const spawnCli = args => {
  const child = spawn("node", ["dist/cli.js", ...args, ...(args[0] === "run" ? ["--patch", "/experiment/cordis.patch.yaml"] : [])], { stdio: "inherit", env: process.env });
  child.on("error", error => { throw error; });
  return child;
};
const exitCode = child => new Promise(done => child.on("exit", done));

// Submit and observe; the job outlives a hard CLI kill (not a SIGINT cancel).
const first = spawnCli(["run", file]);
let receipt;
for (let i = 0; i < 120 && !receipt; i++) {
  await new Promise(done => setTimeout(done, 500));
  const names = await readdir(join(output, ".jobs")).catch(() => []);
  if (names.length === 1) receipt = JSON.parse(await readFile(join(output, ".jobs", names[0]), "utf8"));
}
assert.ok(receipt, "receipt was not written after submission");
first.kill("SIGKILL");
console.log("First CLI killed; job continues on the cluster:", receipt.jobId);

// Resume without a run-id: no local copy yet, so the only live job is reattached.
assert.equal(await exitCode(spawnCli(["run", file, "--resume"])), 0);

const runs = (await readdir(output)).filter(name => !name.startsWith(".")); assert.equal(runs.length, 1);
const directory = join(output, runs[0]); const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
assert.equal(manifest.status, "completed"); assert.equal(manifest.taskIds.length, 2);
const attempts = manifest.remoteAttempts ?? [];
assert.equal(attempts.length, 2); assert.ok(attempts.every(a => a.state === "collected" && a.receipt));
assert.ok(new Set(attempts.map(a => a.nodeId)).size >= 2);
for (const a of attempts) {
  const result = JSON.parse(await readFile(join(directory, "tasks", safeTaskKey(a.key.taskId), "attempts", a.key.attemptId, "result.json"), "utf8"));
  assert.equal(result.executionStatus, "completed"); assert.equal(result.verdict.score, 1);
}
// The follow CLI already rebuilt the report; `report` must reproduce it offline.
await exitCode(spawnCli(["report", directory]));
console.log("Ray Jobs acceptance passed:", directory);
