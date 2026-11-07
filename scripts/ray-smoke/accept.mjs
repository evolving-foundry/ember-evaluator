import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "../../dist/application/config.js";
import { bootstrapBenchmark } from "../../dist/application/plugins/bootstrap.js";
import { safeTaskKey } from "../../dist/core/artifacts/artifacts.js";

const mode = process.argv[2] ?? "controlled";
if (!["controlled", "office", "office-cancel", "live", "fault", "resume", "cancel", "check", "prepare-fail"].includes(mode)) throw new Error("Use controlled, office, office-cancel, live, fault, resume, cancel, check, or prepare-fail");
process.env.EVALUATOR_TRANSFER_TOKEN = (await readFile("/security/token", "utf8")).trim();
process.env.EVALUATOR_SMOKE_MODEL_KEY = "smoke-only-not-a-model-key";
const execute = (args, signal) => new Promise((resolve, reject) => {
  const child = spawn("node", ["dist/cli.js", ...args, ...(args[0] === "run" ? ["--patch", "/experiment/cordis.patch.yaml"] : [])], { stdio: "inherit", env: process.env });
  if (child.pid) writeFileSync("/results/active-cli.pid", String(child.pid));
  if (signal) setTimeout(() => child.kill("SIGINT"), 20_000).unref();
  child.on("error", reject); child.on("exit", code => {
    rm("/results/active-cli.pid", { force: true }).then(() => resolve(code), reject);
  });
});
const experiment = "/experiment/experiment.yaml";
const state = "/results/last.json";
if (mode !== "check") {
  // Verify two distinct evaluator-capable Ray nodes before spending time on data/images.
  execFileSync("python", ["-c", "import ray; ray.init(address='ray://head:10001',log_to_driver=False); nodes=[n['NodeID'] for n in ray.nodes() if n['Alive'] and n['Resources'].get('evaluator_slot',0)>=1]; print(nodes); assert len(set(nodes))>=2; ray.shutdown()"], { stdio: "inherit" });
}
let config;
let before;
if (mode === "resume" || mode === "check") {
  config = JSON.parse(await readFile(state, "utf8"));
  await writeFile(experiment, JSON.stringify(config));
} else {
  const office = ["office", "office-cancel", "live"].includes(mode);
  if (mode === "live") for (const key of ["MODEL_NAME", "MODEL_ENDPOINT", "MODEL_API_KEY"]) assert.ok(process.env[key], `Missing ${key}`);
  config = {
    services: {
      default: mode === "live" ? { model: process.env.MODEL_NAME, base_url: process.env.MODEL_ENDPOINT, api: "openai-completions", api_key: "${MODEL_API_KEY}" }
        : { model: "fixture", base_url: "https://fixture.invalid/v1", api: "openai-completions", provider: "openai", api_key: "${EVALUATOR_SMOKE_MODEL_KEY}" },
    },
    benchmark: {
      ...(office ? { name: "workbuddy", scenario: "office", config: { cacheDir: "/results/cache/office" } } : { name: "ray-fixture", config: { failNodePreparation: mode === "prepare-fail" } }),
      solver: mode === "live" ? { name: "simpleagent", service: "default" } : office ? { name: "office-smoke", service: "default", config: { waitOnce: mode === "office-cancel" } } : { name: "ray-fixture", service: "default", config: { waitOnce: mode === "fault" || mode === "cancel" } },
    },
    environment: { name: office ? "docker" : "local" },
    scheduler: { name: "ray", config: { endpoint: "ray://head:10001", pythonExecutable: "/usr/local/bin/python", concurrency: 2, heartbeatTimeoutMs: 30000, cancelGraceMs: 10000, startupTimeoutMs: 120000,
      collector: { host: "0.0.0.0", port: 9443, publicUrl: "https://coordinator:9443", certFile: "/security/cert.pem", keyFile: "/security/key.pem" } } },
    metrics: [{ name: "harbor-score" }, { name: "duration" }],
    run: { maxTasks: 2, timeoutSeconds: office ? 4500 : 120 },
    output: { directory: `/results/${mode}-${Date.now()}` },
  };
  if (office) {
    await writeFile(experiment, JSON.stringify(config));
    const loaded = await loadConfig(experiment, {}, process.env, { patchPath: "/experiment/cordis.patch.yaml" });
    const components = await bootstrapBenchmark(loaded, "/experiment", "/experiment/cordis.patch.yaml");
    try {
      const signal = new AbortController().signal;
      const source = await components.benchmark.resolveSource(null, signal);
      const taskIds = [];
      for await (const ref of components.benchmark.enumerate(source, signal)) { taskIds.push(ref.id); if (taskIds.length === 2) break; }
      assert.equal(taskIds.length, 2);
      config.run = { taskIds, timeoutSeconds: config.run.timeoutSeconds };
    } finally { await components.dispose(); }
  }
  await writeFile(experiment, JSON.stringify(config));
  await writeFile(state, JSON.stringify(config));
}
async function snapshot() {
  const entries = await readdir(config.output.directory);
  const runs = [];
  for (const name of entries) try { runs.push({ directory: join(config.output.directory, name), manifest: JSON.parse(await readFile(join(config.output.directory, name, "manifest.json"), "utf8")) }); } catch { /* Non-run entries. */ }
  assert.equal(runs.length, 1);
  return runs[0];
}
if (mode === "resume") before = await snapshot();
if (mode !== "check") {
  if (mode === "fault") console.log("Stop one worker in another terminal after its attempt becomes running; restart it before resume.");
  const code = await execute(["run", experiment, ...(mode === "resume" ? ["--resume", before.directory] : [])], mode === "cancel");
  if (!["fault", "cancel", "office-cancel", "prepare-fail"].includes(mode)) assert.equal(code, 0, "CLI run failed");
}
const run = await snapshot();
const attempts = run.manifest.remoteAttempts ?? [];
if (mode === "prepare-fail") {
  assert.equal(run.manifest.status, "error");
  assert.equal(attempts.length, 0, "Preparation failure must not dispatch attempts");
  assert.equal(run.manifest.preparationRounds?.at(-1)?.status, "error");
  assert.equal(await readdir(join(run.directory, "tasks")).then(entries => entries.length).catch(error => { if (error.code === "ENOENT") return 0; throw error; }), 0);
  console.log("Preparation failure barrier passed:", run.directory);
} else if (["fault", "cancel", "office-cancel"].includes(mode)) {
  assert.notEqual(run.manifest.status, "completed");
  assert.ok(attempts.some(a => a.nodeId), "No worker started; infrastructure setup failed before the fault test");
  if (mode === "fault") assert.ok(attempts.some(a => a.state === "uncollected"), "Expected uncollected worker evidence");
  if (mode === "cancel" || mode === "office-cancel") {
    let cancelled = 0;
    for (const attempt of attempts.filter(a => a.state === "collected")) {
      const record = JSON.parse(await readFile(join(run.directory, "tasks", safeTaskKey(attempt.key.taskId), "attempts", attempt.key.attemptId, "result.json"), "utf8"));
      if (record.executionStatus === "cancelled") cancelled++;
    }
    assert.ok(cancelled > 0, "Expected a collected cancelled attempt; reset markers and retry");
  }
  console.log("Partial run retained:", run.directory);
} else {
  assert.equal(run.manifest.status, "completed");
  const collected = attempts.filter(a => a.state === "collected");
  const taskIds = new Set(collected.map(a => a.key.taskId));
  assert.equal(taskIds.size, run.manifest.taskIds.length);
  assert.ok(collected.every(a => a.receipt));
  assert.ok(new Set(collected.map(a => a.nodeId)).size >= 2, "Expected two different Ray node IDs");
  if (["controlled", "office", "live"].includes(mode)) assert.equal(collected.length, run.manifest.taskIds.length, "Unexpected duplicate attempts");
  const records = [];
  for (const taskId of run.manifest.taskIds) {
    const candidates = collected.filter(a => a.key.taskId === taskId);
    const completed = [];
    for (const attempt of candidates) {
      const directory = join(run.directory, "tasks", safeTaskKey(taskId), "attempts", attempt.key.attemptId);
      const record = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
      if (record.executionStatus === "completed") {
        assert.ok(record.verdict && Number.isFinite(record.verdict.score));
        if (config.benchmark.name === "workbuddy") {
          const score = JSON.parse(await readFile(join(directory, "verifier/score.json"), "utf8"));
          assert.equal(score.reward, record.verdict.score);
          assert.equal(score.scoring.implementation, "evaluator-workbuddy-office-rule");
        }
        completed.push(record);
      }
    }
    assert.equal(completed.length, 1, "Task must have one completed attempt");
    records.push(completed[0]);
  }
  if (run.manifest.executionVersion === 2) {
    const rounds = run.manifest.preparationRounds ?? [];
    assert.ok(rounds.some(round => round.status === "ready"), "Missing successful batch preparation");
    for (const record of records) {
      const ready = rounds.find(round => round.status === "ready" && round.taskIds.includes(record.key.taskId) && Date.parse(round.finishedAt) <= Date.parse(record.startedAt));
      assert.ok(ready, "Task started before its preparation barrier");
      assert.ok(ready.placements?.some(item => item.taskId === record.key.taskId && collected.some(attempt => attempt.key.attemptId === record.key.attemptId && attempt.nodeId === item.nodeId)), "Task ran outside its prepared placement");
    }
  }
  const events = records.flatMap(r => [{ at: Date.parse(r.startedAt), delta: 1 }, { at: Date.parse(r.finishedAt), delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  for (const event of events) { active += event.delta; assert.ok(active <= 2, "Concurrency exceeded two"); }
  if (before) for (const old of before.manifest.remoteAttempts ?? []) if (old.state === "collected") {
    // Collected cancellation results may legitimately be replaced on resume.
    const recordPath = join(before.directory, "tasks", safeTaskKey(old.key.taskId), "attempts", old.key.attemptId, "result.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    if (record.executionStatus === "completed") assert.equal(collected.filter(a => a.key.taskId === old.key.taskId).length, 1, "Completed task reran");
  }
  assert.equal(await execute(["report", run.directory]), 0);
  await mkdir("/results/acceptance", { recursive: true });
  await writeFile(`/results/acceptance/${mode}.json`, JSON.stringify({ directory: run.directory, nodes: [...new Set(collected.map(a => a.nodeId))], tasks: taskIds.size }, null, 2));
  console.log("Acceptance passed:", run.directory);
}
