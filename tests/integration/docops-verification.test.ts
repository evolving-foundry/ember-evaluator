import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { afterEach, expect, test } from "vitest";

import type { RunComponents } from "../../src/core/contracts/components.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { DocOpsBenchmark, DocOpsDockerEnvironment } from "../../plugins/docops/index.js";
import { runDockerCommand } from "ember-evaluator";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import { storeRun, trajectoryLines } from "../fixtures/results/store-fixture.js";
import { startDocOpsFixtureSource } from "../fixtures/docops-source.js";

const fixture = join(import.meta.dirname, "../fixtures/docops");
const roots: string[] = [];
const stores: LocalRunStore[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function shell(session: EnvironmentSession, script: string, signal: AbortSignal): Promise<void> {
  const handle = await session.start({ executable: "bash", args: ["-c", script], cwd: session.workdir, env: {}, input: null }, signal);
  const drain = async (stream: AsyncIterable<Uint8Array>) => { for await (const _chunk of stream) { /* drain */ } };
  const [exit] = await Promise.all([handle.done, drain(handle.stdout), drain(handle.stderr)]);
  if (exit.code !== 0 || exit.signal !== null) throw new Error("DocOps fixture solver command failed");
}

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")(
  "moves a DocOps submission into an independent verifier container",
  async () => {
  const root = await mkdtemp(join(tmpdir(), "docops-verification-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  await cp(fixture, sourceRoot, { recursive: true });
  const remote = await startDocOpsFixtureSource(sourceRoot);
  servers.push(remote.server);
  const benchmark = new DocOpsBenchmark({ repository: "fixture/docops", revision: "main", cacheDir: join(root, "cache") }, remote.transport);
  const source = await benchmark.resolveSource(null, new AbortController().signal);
  const taskId = "sample-docops";
  const store = new LocalRunStore();
  stores.push(store);
  const manifest = { ...storeRun, source, taskIds: [taskId] };
  await store.create(join(root, "runs"), manifest, {});
  const docker = new DocOpsDockerEnvironment({
    profile: "amd",
    repository: "fixture/docops",
    revision: "main",
    cacheDir: join(root, "image-cache"),
  }, { apiBase: remote.transport.apiBase, lfsBase: remote.transport.rawBase });
  const containerIds: string[] = [];
  const components: RunComponents = {
    benchmark,
    environment: {
      async prepare(spec, paths, phase, signal) {
        const session = await docker.prepare(spec, paths, phase, signal);
        containerIds.push(session.id);
        return session;
      },
    },
    solver: {
      requirements: () => [],
      async solve(_input, session, context) {
        await shell(session, "cat /root/input.txt > output.txt", context.signal);
        await writeFile(join(context.paths.agent, "trajectory.jsonl"), trajectoryLines([1, 2], context.key));
        await writeFile(join(context.paths.agent, "session.jsonl"), "{}\n");
        return { finalText: "created document", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      },
    },
    store,
    scheduler: new LocalScheduler(1),
    metrics: [],
    reporter: { async render() { return "docops fixture"; } },
    pluginVersions: { "docops-plugin": "fixture" },
    async dispose() { await store.close(); },
  };
  const record = await runTask({
    runId: manifest.runId,
    taskId,
    attemptId: "docops-pass",
    ref: { id: taskId, recordKey: taskId },
    configFingerprint: manifest.configFingerprint,
  }, components, source, new AbortController().signal, { timeoutSeconds: 180, cleanupTimeoutMs: 15_000 });

  expect(record.errors).toEqual([]);
  expect(record.executionStatus).toBe("completed");
  expect(record.verdict).toMatchObject({ score: 1, passed: true });
  expect(containerIds).toHaveLength(2);
  expect(new Set(containerIds).size).toBe(2);
  for (const id of containerIds) await expect(runDockerCommand("docker", ["inspect", id])).rejects.toThrow(/no such/iu);
  const snapshot = await store.snapshot();
  const attemptRoot = snapshot.records[0]!.key.attemptId;
  expect(attemptRoot).toBe("docops-pass");
  const runDir = join(root, "runs", manifest.runId);
  const verifierRewards = await readFile(join(runDir, "tasks", safeTaskKey(taskId), "attempts", "docops-pass", "verifier", "reward.txt"), "utf8");
  expect(verifierRewards).toBe("1\n");
  },
  180_000,
);
