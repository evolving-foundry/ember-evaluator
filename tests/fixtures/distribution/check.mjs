import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { request } from "node:https";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import * as api from "ember-evaluator";
import { openPluginRegistry } from "./dist/application/plugins/runtime.js";
import { verifyPackageDirectory } from "./dist/infrastructure/provenance/package.js";
import { createPiRuntimeInstallation } from "./dist/runtimes/pi/package-runtime.js";
import { piAgentBundleRuntimeInstallation } from "./dist/runtimes/pi/agentbundle-runtime.js";

const root = process.cwd(), checks = [], skipped = [];
function record(message) { checks.push(message); console.log(message); }
const dir = join(root, ".validation");
await mkdir(dir, { recursive: true });
for (const name of ["src", "scripts"]) await assert.rejects(access(join(root, name)), { code: "ENOENT" });
const paths = ["index.js", "index.d.ts", "cli.js", "cli-runtime.js", "adapters/ray/node-worker.js",
  "adapters/ray/jobs-entry.js", "adapters/ray/jobs-retry-entry.js", "adapters/ray/jobs-gateway.js",
  "adapters/ray/python/requirements.txt", "adapters/harness/pi/runner.js",
  "adapters/harness/pi/runtime-package.json", "adapters/harness/pi/runtime-lock.json",
  "adapters/harness/agentx/assets/ascend_metrics.py"];
for (const path of paths) await access(join(root, "dist", path));
const digest = await verifyPackageDirectory(join(root, "dist"));
const legacyPi = join(root, "dist/adapters/harness/pi");
for (const name of await readdir(legacyPi)) {
  if (!name.endsWith(".js")) continue;
  const file = join(legacyPi, name), content = await readFile(file, "utf8");
  for (const match of content.matchAll(/(?:from\s+|import\s*\()(["'])(\.[^"']+)\1/g))
    await access(resolve(dirname(file), match[2]));
  for (const match of content.matchAll(/new URL\(\s*["'](\.[^"']*)["']\s*,\s*import.meta.url\s*\)/g))
    await access(new URL(match[1], pathToFileURL(file)));
}
record("declared assets and complete distribution digest");
const piInstallation = await createPiRuntimeInstallation(new AbortController().signal);
for (const file of piInstallation.files) await access(file.source);
// Preparation must keep its coordinator resource paths, independently of the
// runner dependency copies used in standalone installations.
const bundleInstallation = await piAgentBundleRuntimeInstallation(new AbortController().signal,
  { root: dir, pythonPackages: [], pythonRequiredModules: [] }, "fixture-artifact", "fixture-configuration");
const agentBundleEntry = bundleInstallation.files.find(file => file.target === "agentbundle/run.mjs");
assert.ok(agentBundleEntry);
await access(agentBundleEntry.source);
record("installed Pi and AgentBundle preparation resolve coordinator resources");

function launch(file, args = [], env = {}, executable = process.execPath) {
  const child = spawn(executable, [file, ...args], { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Process timeout: ${file}\n${stderr}`)); }, 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return { child, done, output: () => stdout + stderr };
}
async function run(file, args = [], input = "", env = {}, executable) {
  const process = launch(file, args, env, executable);
  process.child.stdin.end(input);
  return process.done;
}
const help = await run("dist/cli.js", ["--help"]);
assert.equal(help.code, 0, help.stderr);
assert.match(help.stdout, /benchmark|run/);
record("installed CLI help and exit code");
const pi = await run("dist/adapters/harness/pi/runner.js", [], "{}\n");
assert.equal(pi.code, 1, pi.stderr);
assert.equal(JSON.parse(pi.stdout.trim().split("\n").at(-1)).type, "error");
record("standalone Pi entry rejects invalid protocol input");
const model = createServer(async (req, res) => {
  let body = ""; for await (const data of req) body += data;
  const input = JSON.parse(body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = { id: "controlled", object: "chat.completion.chunk", created: 1, model: input.model };
  for (const choice of [{ delta: { role: "assistant", content: "controlled answer" }, finish_reason: null }, { delta: {}, finish_reason: "stop" }])
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, ...choice }] })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise(done => model.listen(0, "127.0.0.1", done));
try {
  const workdir = join(dir, "pi-work"), outputDir = join(dir, `pi-output-${randomUUID()}`);
  await mkdir(workdir, { recursive: true }); await mkdir(outputDir, { recursive: true });
  const input = { schemaVersion: 1, key: { runId: "run", taskId: "task", attemptId: "attempt" }, input: { id: "task", prompt: "Return the controlled answer." },
    model: { name: "fixture", endpoint: `http://127.0.0.1:${model.address().port}/v1`, provider: "openai", api: "openai-completions" },
    auth: { value: "controlled-key", reference: null }, workdir, outputDir };
  const completed = await run("dist/adapters/harness/pi/runner.js", [], JSON.stringify(input) + "\n");
  assert.equal(completed.code, 0, completed.stderr + completed.stdout);
  const reply = completed.stdout.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "result");
  assert.equal(reply.result.finalText, "controlled answer");
  await access(join(outputDir, "trajectory.jsonl"));
  record("standalone Pi runner completes a controlled model request and saves its trajectory");
} finally { model.closeAllConnections(); await new Promise(done => model.close(done)); }

const network = join(dir, "network.yaml");
await writeFile(network, "{}\n");
const fixture = join(dir, "plugin.mjs"), patch = join(dir, "patch.yaml");
await writeFile(patch, JSON.stringify([{ insert: [{ id: "distribution-fixture", name: "./plugin.mjs" }] }]));
const config = join(dir, "experiment.yaml");
await writeFile(config, JSON.stringify({ services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${DISTRIBUTION_MODEL_KEY}" } },
  benchmark: { name: "cli-fixture", solver: { name: "cli-fixture" } }, environment: "local", output: { directory: "./results" } }));
const result = await new api.Evaluator().run({ configPath: config, patchPath: patch, networkConfigPath: network,
  env: { DISTRIBUTION_MODEL_KEY: "controlled-model-key" } });
assert.equal(result.exitCode, 0);
await api.rebuildReport(result.runDirectory);
record("package-name SDK, patch, evaluation and offline report");

// Jobs inputs must be consumed even when validation fails; mere module loading cannot pass.
const jobsRoot = join(dir, "jobs"), security = join(dir, "security"), jobId = randomUUID();
await mkdir(join(jobsRoot, jobId), { recursive: true });
await mkdir(security, { recursive: true });
await writeFile(join(jobsRoot, jobId, "input.json"), JSON.stringify({ operation: "invalid-operation" }));
const jobsEnv = { EVALUATOR_JOBS_ROOT: jobsRoot, EVALUATOR_JOBS_SECURITY: security, EVALUATOR_NETWORK_CONFIG: network };
const job = await run("dist/adapters/ray/jobs-entry.js", [jobId], "", jobsEnv);
assert.equal(job.code, 1); assert.match(job.stderr, /Invalid job operation/);
await assert.rejects(access(join(jobsRoot, jobId, "input.json")), { code: "ENOENT" });
const retryAuth = join(jobsRoot, jobId, "retry-auth-request.json");
await writeFile(retryAuth, "{}");
const retry = await run("dist/adapters/ray/jobs-retry-entry.js", [jobId, randomUUID(), "request"], "", jobsEnv);
assert.equal(retry.code, 1); assert.match(retry.stderr, /config.yaml/);
await assert.rejects(access(retryAuth), { code: "ENOENT" });
record("Jobs and retry process actual inputs, clean staged files and fail nonzero");

const openssl = process.env.OPENSSL_BIN ?? "openssl";
if (spawnSync(openssl, ["version"], { windowsHide: true }).status !== 0) {
  skipped.push("worker HTTPS transfer and Jobs gateway: OpenSSL unavailable");
} else {
  const opensslConfig = join(security, "openssl.cnf");
  await writeFile(opensslConfig, "[req]\ndistinguished_name = dn\n[dn]\n");
  const certificate = spawnSync(openssl, ["req", "-config", opensslConfig, "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(security, "key.pem"), "-out", join(security, "cert.pem"), "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"], { windowsHide: true });
  assert.equal(certificate.status, 0, certificate.stderr.toString());
  const token = randomUUID() + randomUUID(), cert = await readFile(join(security, "cert.pem"));
  const accepted = [];
  const receiver = new api.DirectoryReceiver(join(dir, "received"), async manifest => { accepted.push(manifest); return true; });
  const collector = await api.startTransferReceiver({ receiver, token, cert, key: await readFile(join(security, "key.pem")),
    control: async route => route === "runtime" ? { services: { default: { model: { name: "fixture", endpoint: "https://fixture.invalid", api: "openai-completions", provider: null }, auth: { value: "controlled-model-key", reference: null } } } } : { cancelled: false } });
  const registry = await openPluginRegistry(patch);
  try {
    const nodePath = join(dir, "node.json");
    await writeFile(nodePath, JSON.stringify({ nodeExecutable: process.execPath, workerEntry: resolve("dist/adapters/ray/node-worker.js"), configDirectory: dir,
      outputRoot: join(dir, "worker"), caFile: join(security, "cert.pem"), pluginPatchPath: patch, tokenEnv: "DISTRIBUTION_TRANSFER_TOKEN" }));
    const workerEnv = { EVALUATOR_NODE_CONFIG: nodePath, DISTRIBUTION_TRANSFER_TOKEN: token };
    const remote = { schemaVersion: 1, job: { runId: randomUUID(), taskId: "task", attemptId: randomUUID(), ref: { id: "task", recordKey: 0 }, configFingerprint: "a".repeat(64) },
      source: { source: "cli-fixture", revision: "fixed", files: [], metadata: {} },
      safeConfig: { benchmark: { name: "cli-fixture", config: {} }, environment: { name: "local", config: {} }, solver: { name: "cli-fixture", service: "default", config: {} }, timeoutSeconds: 20 },
      pluginVersions: registry.pluginVersions, packageDigest: digest, uploadEndpoint: collector.url, previousAttempts: [] };
    const worker = await run("dist/adapters/ray/node-worker.js", [], JSON.stringify({ remote, nodeId: "controlled-node", hostname: "controlled-host" }), workerEnv);
    assert.equal(worker.code, 0, worker.stderr + worker.stdout);
    assert.equal(JSON.parse(worker.stdout).nodeId, "controlled-node");
    assert.equal(accepted.length, 1); assert.equal(accepted[0].result.executionStatus, "completed");
    assert.equal(accepted[0].result.verdict.score, 1);
    record("legacy workerEntry executes a real attempt and uploads evidence over HTTPS");
    const bad = await run("dist/adapters/ray/node-worker.js", [], JSON.stringify({ remote: { ...remote, packageDigest: "sha256:" + "0".repeat(64) }, nodeId: "controlled-node", hostname: "controlled-host" }), workerEnv);
    assert.equal(bad.code, 1); assert.equal(JSON.parse(bad.stdout).errorCode, "SOURCE_CHANGED");
    record("worker rejects a coordinator with a different package digest");
    const maintenance = { pluginVersions: registry.pluginVersions, packageDigest: digest, environment: { name: "distribution-maintenance", config: {} }, request: { all: true, execute: false } };
    const cleanup = await run("dist/adapters/ray/node-worker.js", ["--image-cleanup"], JSON.stringify(maintenance), workerEnv);
    assert.equal(cleanup.code, 0, cleanup.stderr); assert.equal(JSON.parse(cleanup.stdout).nodeId, "fixture-node");
    await rm(join(dir, "lease-released"), { force: true });
    const lease = launch("dist/adapters/ray/node-worker.js", ["--image-lease"], workerEnv);
    lease.child.stdin.write(JSON.stringify(maintenance) + "\n");
    for (let i = 0; i < 100 && !lease.output().includes("ready"); i++) await delay(50);
    assert.match(lease.output(), /ready/); lease.child.stdin.end();
    assert.equal((await lease.done).code, 0);
    assert.equal(await readFile(join(dir, "lease-released"), "utf8"), "released");
    record("legacy worker image cleanup and lease release");
  } finally { await registry.dispose(); await collector.close(); }
  await writeFile(join(security, "jobs-token"), token);
  const gateway = launch("dist/adapters/ray/jobs-gateway.js", [], { ...jobsEnv, EVALUATOR_JOBS_PORT: "0" });
  try {
    for (let i = 0; i < 100 && !/HTTPS :(\d+)/.test(gateway.output()); i++) await delay(50);
    const port = /HTTPS :(\d+)/.exec(gateway.output())?.[1]; assert.ok(port, gateway.output());
    const status = await new Promise((done, fail) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/unknown", ca: cert }, res => { res.resume(); res.on("end", () => done(res.statusCode)); });
      req.on("error", fail); req.end();
    });
    assert.equal(status, 401);
    record("legacy Jobs gateway listens and enforces authentication");
  } finally { gateway.child.kill(); await gateway.done; }
}

const python = process.env.PYTHON_BIN ?? "python";
if (spawnSync(python, ["--version"], { windowsHide: true }).status !== 0) skipped.push("AgentX Python command: Python unavailable");
else {
  const help = await run("dist/adapters/harness/agentx/assets/ascend_metrics.py", ["--help"], "", {}, python);
  assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /--device-id/);
  const controlled = await run(join(dir, "telemetry.py"), [resolve("dist/adapters/harness/agentx/assets/ascend_metrics.py")], "", {}, python);
  assert.equal(controlled.code, 0, controlled.stderr); assert.match(controlled.stdout, /ascend_npu_utilization_percent/);
  record("AgentX legacy Python CLI, controlled sampler HTTP output and orderly shutdown");
}
const report = { checks, skipped };
await writeFile(join(dir, "verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
