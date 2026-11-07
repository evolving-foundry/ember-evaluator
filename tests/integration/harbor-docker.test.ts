import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { HarborShellVerifier } from "../../src/plugins/verifiers/shell.js";
import { readProcess } from "../../src/infrastructure/process/output.js";
import type { EnvironmentSession, EnvironmentSpec } from "../../src/core/contracts/environment.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";
import { HarborBenchmark, parseHarborConfig } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/index.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { harness } from "../fixtures/engine/fakes.js";
import { storeRun } from "../fixtures/results/store-fixture.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";

const enabled = process.env.EVALUATOR_HARBOR_DOCKER_TESTS === "1";
const base: EnvironmentSpec = { image: "node:24.22.1-bookworm-slim", workdir: "/app", runtime: [], initialFiles: [], network: "none" };
const signal = () => AbortSignal.timeout(120_000);
async function exec(session: EnvironmentSession, command: string) {
  return readProcess(await session.start({ executable: "bash", args: ["-c", command], cwd: session.workdir, env: {}, input: null }, signal()), signal());
}

test.skipIf(!enabled).each(["shared", "separate"] as const)("Harbor Docker %s grading without artifact collection keeps logs and does not create a delivery archive", async mode => {
  const root = await mkdtemp(join(tmpdir(), "harbor-unconfigured-artifacts-"));
  const value = harness(root);
  try {
    const dataset = join(root, "dataset");
    const image = process.env.EVALUATOR_DOCKER_TEST_IMAGE ?? base.image;
    await writeFixture(dataset, {
      "tasks/example/task.toml": `${mode === "shared" ? "artifacts = []\n" : ""}[task]\nname="bench/example"\n[environment]\ndocker_image="${image}"\nworkdir="/workspace"\n[verifier]\nenvironment_mode="${mode}"\n`,
      "tasks/example/instruction.md": "Write /workspace/output/result.md.\n",
      "tasks/example/tests/test.sh": (mode === "shared" ? 'test "$(cat /workspace/output/result.md)" = answer\n' : 'test ! -e /workspace/output/result.md\n') + 'printf \'{"reward":1}\' > /logs/verifier/reward.json\n',
    });
    value.components.benchmark = new HarborBenchmark(parseHarborConfig({ source: { kind: "local", path: dataset }, cacheDir: join(root, "cache") }));
    value.components.environment = new DockerEnvironment();
    const source = await value.components.benchmark.resolveSource(null, signal());
    const refs = [];
    for await (const ref of value.components.benchmark.enumerate(source, signal())) refs.push(ref);
    const ref = refs[0]; if (!ref) throw new Error("Missing test task");
    const solve = value.components.solver.solve.bind(value.components.solver);
    value.components.solver.solve = async (input, session, context) => {
      expect((await exec(session, "mkdir -p /workspace/output; printf answer > /workspace/output/result.md; echo solve-log")).code).toBe(0);
      return solve(input, session, context);
    };
    await value.components.store.create(value.config.experiment.output.directory, { ...storeRun, source, taskIds: [ref.id] }, {});
    const record = await runTask({ runId: storeRun.runId, taskId: ref.id, attemptId: "first", ref, configFingerprint: storeRun.configFingerprint },
      value.components, source, signal());
    expect(record).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", verdict: { score: 1 },
      cleanupStatus: "cleaned", collection: { artifacts: "not-produced", trajectory: "complete" } });
    expect(record.warnings ?? []).toEqual([]);
    const attempt = join(value.config.experiment.output.directory, storeRun.runId, "tasks", safeTaskKey(ref.id), "attempts/first");
    expect(JSON.parse(await readFile(join(attempt, "verifier/reward.json"), "utf8"))).toEqual({ reward: 1 });
    await access(join(attempt, "agent/session.jsonl"));
    await expect(access(join(attempt, "artifacts/artifacts.tar"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await value.dispose(); await rm(root, { recursive: true, force: true }); }
}, 180_000);

test.skipIf(!enabled)("Harbor Docker shared verification preserves deliverables and admits private tests only after solve", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-docker-")); const environment = new DockerEnvironment(); let session: EnvironmentSession | undefined;
  try {
    const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
    session = await environment.prepare({ ...base, sharedLogs: true }, paths, "solve", signal());
    expect((await exec(session, "test ! -f /tests/test.sh; mkdir -p /logs/artifacts; echo answer > /app/answer; echo output > /logs/artifacts/result.txt")).code).toBe(0);
    await writeFixture(root, { "task/tests/test.sh": 'test "$(cat /app/answer)" = answer || exit 5\nprintf \'{"reward":0.5,"f2p":1}\' > /logs/verifier/reward.json\nexit 1\n' });
    await session.transitionToVerification!("none", signal());
    const verifier = new HarborShellVerifier();
    const descriptor = await verifier.prepare({ id: "shared", taskDir: join(root, "task"), datasetDir: root, workdir: "/app", timeoutSeconds: 30 }, signal());
    expect(await verifier.verify({ descriptor, env: {} }, session, signal())).toMatchObject({ rewards: { reward: 0.5, f2p: 1 }, details: { exitCode: 1 } });
    expect((await readFile(join(root, "logs/artifacts/result.txt"), "utf8")).trim()).toBe("output");
    expect(JSON.parse(await readFile(join(paths.verifier, "reward.json"), "utf8"))).toEqual({ reward: 0.5, f2p: 1 });
  } finally { await session?.dispose(signal()); await rm(root, { recursive: true, force: true }); }
}, 180_000);

test.skipIf(!enabled)("Harbor Docker separate verification restores a declared file with a different workdir", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-artifacts-")); const environment = new DockerEnvironment(); const sessions: EnvironmentSession[] = [];
  try {
    const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
    const solve = await environment.prepare(base, paths, "solve", signal()); sessions.push(solve);
    await solve.transitionToVerification!(undefined, signal());
    expect((await exec(solve, "mkdir -p /logs/artifacts; printf patch > /logs/artifacts/model.patch")).code).toBe(0);
    await solve.quiesce!(signal());
    const artifact = await solve.exportState({ kind: "artifacts", workdir: "/app", paths: ["/logs/artifacts/model.patch"] }, join(paths.artifacts, "artifacts.tar"), signal());
    const verify = await environment.prepare({ ...base, workdir: "/grading" }, paths, "verify", signal()); sessions.push(verify);
    await verify.restoreState(artifact, signal());
    expect((await exec(verify, "cat /logs/artifacts/model.patch")).stdout).toBe("patch");
    await expect(solve.exportState({ kind: "artifacts", workdir: "/app", paths: ["/logs/artifacts/missing"] }, join(paths.artifacts, "missing.tar"), signal())).rejects.toThrow();
  } finally { await Promise.all(sessions.map(session => session.dispose(signal()))); await rm(root, { recursive: true, force: true }); }
}, 180_000);
