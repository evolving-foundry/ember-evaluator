import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RunComponents } from "../../src/core/contracts/components.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { readProcess } from "../../src/infrastructure/process/output.js";
import { trajectoryLines } from "../fixtures/results/store-fixture.js";
import { restoreLogOwnersSource } from "../../src/infrastructure/containers/log-ownership.js";
import { dshOutputRuntimeFile } from "../../src/runtimes/dsh/runtime.js";

const enabled = process.env.EVALUATOR_TEST_DOCKER === "1" && process.platform === "linux" && process.getuid?.() !== 0;

test.skipIf(!enabled)("root DSH exports are readable by the coordinator before quiescence", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-dsh-live-output-"));
  const output = join(root, "agent");
  await mkdir(output);
  try {
    const { stdout } = await promisify(execFile)("docker", ["run", "--rm", "--network", "none", "--mount",
      `type=bind,source=${output},target=/logs/agent`, "--mount",
      `type=bind,source=${dshOutputRuntimeFile().source},target=/hook.mjs,readonly`, "--entrypoint", "node", PINNED_NODE_IMAGE,
      "--input-type=module", "-e", "const {serializeToolResult}=await import('/hook.mjs');console.log(serializeToolResult({callId:'large',status:'completed',result:'private output'.repeat(2000)},'/logs/agent'))"], { timeout: 30000 });
    const record = JSON.parse(stdout) as { resultRef: string; storedBytes: number };
    const file = join(root, record.resultRef);
    expect(Buffer.byteLength(await readFile(file, "utf8"))).toBe(record.storedBytes);
    expect((await stat(file)).uid).toBe(process.getuid?.());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(output, "tool-outputs"))).mode & 0o777).toBe(0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 35000);

test.skipIf(!enabled).each(["success", "failure", "cancel"] as const)(
  "non-root Linux collects private Docker logs after a fresh %s attempt", async mode => {
    const root = await mkdtemp(join(tmpdir(), "evaluator-log-owner-"));
    const runId = randomUUID();
    const ids = Array.from({ length: mode === "success" ? 4 : 1 }, (_, index) => `fresh-${index}`);
    const source = { source: "fixture", revision: "fixed", files: [], metadata: {} };
    const controller = new AbortController();
    const store = new LocalRunStore();
    const environment = new DockerEnvironment();
    const components: RunComponents = {
      store, environment, scheduler: new LocalScheduler(4), pluginVersions: { fixture: "1" }, metrics: [],
      reporter: { async render() { return "fixture"; } }, async dispose() { await store.close(); },
      benchmark: {
        async resolveSource() { return source; }, async *enumerate() { for (const id of ids) yield { id, recordKey: id }; },
        async prepare(ref) { return {
          input: { id: ref.id, prompt: "File ownership fixture" }, verification: {}, verificationMode: "shared",
          solveEnv: { image: PINNED_NODE_IMAGE, workdir: "/workspace", initialFiles: [], runtime: [], sharedLogs: true, network: "none" },
          verifyEnv: null, transfer: null,
        }; },
        async verify(_task, _solved, session, signal) {
          if (!session) throw new Error("Missing shared verifier session");
          await readProcess(await session.start({ executable: "node", args: ["-e",
            "require('node:fs').writeFileSync('/logs/verifier/reward.json','{\"reward\":1}',{mode:0o600})"],
            cwd: session.workdir, env: {}, input: null }, signal), signal);
          return { score: 1, passed: true, details: {} };
        },
      },
      solver: {
        requirements: () => [],
        async solve(_input, session, context) {
          const lines = trajectoryLines(mode === "cancel" ? [1] : [1, 2], context.key);
          const script = "const fs=require('node:fs');fs.writeFileSync('/logs/agent/session.jsonl','{}\\n',{mode:0o600});fs.writeFileSync('/logs/agent/trajectory.jsonl',process.argv[1],{mode:0o600});";
          const result = await readProcess(await session.start({ executable: "node", args: ["-e", script, lines],
            cwd: session.workdir, env: {}, input: null }, context.signal), context.signal);
          if (result.code !== 0) throw new Error(result.stderr);
          if (mode === "failure") throw new Error("fixture solver failure");
          if (mode === "cancel") { controller.abort(new Error("fixture cancellation")); context.signal.throwIfAborted(); }
          return { finalText: "fixture", usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
        },
      },
    };
    try {
      await store.create(root, { schemaVersion: 1, evaluationKind: "quality", runId, source, taskIds: ids, configFingerprint: "fixture",
        pluginVersions: { fixture: "1" }, startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, status: "running" }, {});
      const records = await Promise.all(ids.map(taskId => runTask({ runId, taskId, attemptId: randomUUID(),
        configFingerprint: "fixture", ref: { id: taskId, recordKey: taskId } }, components, source, controller.signal, { timeoutSeconds: 120 })));
      for (const record of records) {
        const attempt = join(root, runId, "tasks", safeTaskKey(record.key.taskId), "attempts", record.key.attemptId);
        expect(record.collection.trajectory).toBe(mode === "cancel" ? "partial" : "complete");
        expect(JSON.parse(await readFile(join(attempt, "files.json"), "utf8")).missing).toEqual([]);
        if (mode === "success") expect(record.errors).toEqual([]);
        else expect(record.executionStatus).toBe(mode === "cancel" ? "cancelled" : "failed");
        for (const name of ["session.jsonl", "trajectory.jsonl"]) {
          const file = join(attempt, "agent", name);
          expect((await readFile(file, "utf8")).length).toBeGreaterThan(0);
          expect((await stat(file)).uid).toBe(process.getuid?.());
          expect((await stat(file)).mode & 0o777).toBe(0o600);
        }
      }
      await store.snapshot();
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  }, 180_000,
);

test.skipIf(!enabled)("log ownership handoff leaves symlink targets outside the log mounts untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-log-owner-links-"));
  const script = join(root, "proof.mjs");
  await writeFile(script, `const helper = ${JSON.stringify(restoreLogOwnersSource)};\n` + String.raw`
import { mkdir, writeFile, symlink, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
await mkdir("/logs/agent", { recursive: true });
await mkdir("/outside", { recursive: true });
await writeFile("/logs/agent/session.jsonl", "private", { mode: 0o600 });
await writeFile("/outside/private", "outside", { mode: 0o600 });
await symlink("/outside/private", "/logs/agent/link");
execFileSync(process.execPath, ["--input-type=module", "-e", helper, JSON.stringify([{ path: "/logs/agent", uid: 1000, gid: 1000 }])]);
const output = await stat("/logs/agent/session.jsonl");
const outside = await stat("/outside/private");
console.log(JSON.stringify({ uid: output.uid, mode: output.mode & 0o777, outsideUid: outside.uid, outsideMode: outside.mode & 0o777 }));
`);
  try {
    const { stdout } = await promisify(execFile)("docker", ["run", "--rm", "--network", "none", "--mount",
      `type=bind,source=${script},target=/proof.mjs,readonly`, "--entrypoint", "node", PINNED_NODE_IMAGE, "/proof.mjs"], { timeout: 30000 });
    expect(JSON.parse(stdout)).toEqual({ uid: 1000, mode: 0o600, outsideUid: 0, outsideMode: 0o600 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 35000);
