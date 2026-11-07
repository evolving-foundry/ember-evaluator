import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "tar";
import { expect, test } from "vitest";
import { readProcess } from "../../src/infrastructure/process/output.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import type { EnvironmentSpec } from "../../src/core/contracts/environment.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { computeSuccessRate } from "../../src/plugins/metrics/success-rate.js";
import { harness, source } from "../fixtures/engine/fakes.js";
import { storeRun, trajectoryLines } from "../fixtures/results/store-fixture.js";

const enabled = process.env.EVALUATOR_COMPOSE_DOCKER_TESTS === "1";
const image = process.env.EVALUATOR_COMPOSE_TEST_IMAGE ?? "node:24.22.1-bookworm-slim";
const dockerExecutable = process.env.EVALUATOR_TEST_DOCKER_EXECUTABLE ?? "docker";

test.skipIf(!enabled).each(["timeout", "cancel"] as const)("multi-container %s collects without restarting task startup or sidecars", async mode => {
  const root = await mkdtemp(join(process.env.EVALUATOR_COMPOSE_TEST_TMP ?? tmpdir(), "compose-timeout-"));
  const value = harness(root);
  const runId = randomUUID();
  const controller = new AbortController();
  const spec: EnvironmentSpec = {
    image, workdir: "/app", runtime: [], initialFiles: [], network: "bridge",
    services: {
      main: { image: null, properties: {
        entrypoint: ["node", "-e", "const fs=require('fs');fs.mkdirSync('/app',{recursive:true});fs.appendFileSync('/app/startups','first\\n');setInterval(()=>{},3600000)"],
        depends_on: { evidence: { condition: "service_healthy" } },
      } },
      evidence: { image, properties: {
        command: ["node", "-e", "const id=require('crypto').randomUUID();require('http').createServer((q,r)=>r.end(id)).listen(8080)"],
        healthcheck: { test: ["CMD", "node", "-e", "fetch('http://localhost:8080').then(r=>process.exit(r.ok?0:1))"], interval: "1s", timeout: "3s", retries: 20 },
      } },
    },
  };
  const environment = new DockerEnvironment({ dockerExecutable });
  value.components.environment = environment;
  value.components.benchmark.prepare = async () => ({
    input: { id: "a", prompt: "Write a deliverable" }, verification: {}, verificationMode: "separate",
    solveEnv: spec, verifyEnv: { image, workdir: "/app", runtime: [], initialFiles: [], network: "none" },
    transfer: { kind: "artifacts", workdir: "/app", paths: ["/app", "/tmp/snapshot"], services: { "/tmp/snapshot": "evidence" } },
    collect: [{ service: "evidence", executable: "node", args: ["-e", "fetch('http://localhost:8080').then(r=>r.text()).then(id=>require('fs').writeFileSync('/tmp/snapshot',id))"], cwd: "/", env: {}, timeoutSeconds: 15 }],
  });
  value.components.solver.requirements = () => [];
  let solveStarted = false;
  value.components.solver.solve = async (_input, session, context) => {
    await writeFile(join(context.paths.agent, "trajectory.jsonl"), trajectoryLines([1], context.key));
    await writeFile(join(context.paths.agent, "session.jsonl"), '{"fixture":true}\n');
    const proof = await readProcess(await session.start({ executable: "node", args: ["-e",
      "fetch('http://evidence:8080').then(r=>r.text()).then(id=>{const fs=require('fs');fs.writeFileSync('/app/expected-boot',id);fs.writeFileSync('/app/deliverable','partial answer')})"], cwd: "/app", env: {}, input: null }, context.signal), context.signal);
    expect(proof.code).toBe(0);
    const handle = await session.start({ executable: "node", args: ["-e", "setInterval(()=>{},3600000)"], cwd: "/app", env: {}, input: null }, context.signal);
    solveStarted = true;
    if (mode === "cancel") controller.abort(new Error("user cancelled"));
    await readProcess(handle, context.signal);
    throw new Error("unreachable");
  };
  value.components.benchmark.verify = async () => { throw new Error("Verification must not run after timeout or cancellation"); };
  try {
    await value.components.store.create(value.config.experiment.output.directory, { ...storeRun, runId, source, taskIds: ["a"] }, {});
    const record = await runTask({ runId, taskId: "a", attemptId: "first", ref: { id: "a", recordKey: "a" }, configFingerprint: storeRun.configFingerprint },
      value.components, source, controller.signal, { timeoutSeconds: 180, solveTimeoutSeconds: 5 });
    expect(solveStarted, JSON.stringify(record.errors)).toBe(true);
    expect(record.collection.artifacts, JSON.stringify(record.errors)).toBe("complete");
    expect(record).toMatchObject({ executionStatus: mode === "timeout" ? "agent_timeout" : "cancelled",
      scoreStatus: mode === "timeout" ? "valid" : "invalid", verdict: null, collection: { artifacts: "complete" }, cleanupStatus: "cleaned" });
    expect(record.errors.map(error => error.code)).toEqual(mode === "timeout"
      ? ["SOLVER_AGENT_TIMEOUT"] : ["RUN_CANCELLED", "ARTIFACT_COLLECTION_INCOMPLETE"]);
    const attempt = join(value.config.experiment.output.directory, runId, "tasks", safeTaskKey("a"), "attempts", "first");
    expect(await readFile(join(attempt, "collect/001/stdout.log"), "utf8")).toBe("");
    const extracted = join(root, "extracted");
    await mkdir(extracted);
    await extract({ file: join(attempt, "artifacts/artifacts.tar"), cwd: extracted });
    expect(await readFile(join(extracted, "payload/0/deliverable"), "utf8")).toBe("partial answer");
    expect(await readFile(join(extracted, "payload/0/startups"), "utf8")).toBe("first\n");
    expect(await readFile(join(extracted, "payload/1"), "utf8")).toBe(await readFile(join(extracted, "payload/0/expected-boot"), "utf8"));
    if (mode === "timeout") expect(computeSuccessRate(await value.components.store.snapshot())).toMatchObject({ denominator: 1, invalid: 0, passed: 0, rate: 0 });
    const signal = AbortSignal.timeout(15_000);
    for (const resource of ["ps", "network", "volume"]) {
      const args = resource === "ps" ? ["ps", "--all", "--quiet"] : [resource, "ls", "--quiet"];
      const remaining = await runDockerCommand(dockerExecutable, [...args, "--filter", `label=ember.run=${runId}`], { signal });
      expect(remaining.stdout.trim()).toBe("");
    }
  } finally {
    await value.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
