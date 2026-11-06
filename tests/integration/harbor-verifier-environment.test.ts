import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadGenericHarborTask } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/task.js";
import { parseHarborConfig } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/config.js";
import { HarborShellVerifier } from "../../src/plugins/verifiers/shell.js";
import type { EnvironmentSession, ProcessHandle } from "../../src/core/contracts/environment.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";

const roots: string[] = [];
const signal = () => AbortSignal.timeout(30_000);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function prepare(options: { verifier?: string; files?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harbor-verifier-environment-"));
  roots.push(root);
  await writeFixture(root, {
    "task.toml": '[environment]\ndocker_image="agent:locked"\nworkdir="/app"\ncpus=2\nmemory_mb=4096\nstorage_mb=10240\n[verifier]\nenvironment_mode="separate"\n' + (options.verifier ?? ""),
    "instruction.md": "Write /app/result.txt.\n",
    "tests/test.sh": "echo 1 > /logs/verifier/reward.txt\n",
    ...options.files,
  });
  return { root, task: await loadGenericHarborTask(root, root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal()) };
}

test("separate mode builds private tests even when the agent has an explicit image", async () => {
  const { root, task } = await prepare({ files: { "tests/Dockerfile": "FROM grading:locked\nCOPY grader /opt/grader\nCOPY . /tests\n", "tests/grader/reference": "private reference" } });
  expect(task.solveEnv).toMatchObject({ image: "agent:locked" });
  expect(task.solveEnv.build).toBeUndefined();
  expect(task.verifyEnv).toMatchObject({ image: null, workdir: "/app", resources: { cpus: 2, memory: "4096m", storage: "10240m" },
    build: { context: join(root, "tests"), dockerfile: "Dockerfile", visibility: "verifier" } });
  expect(task.verification).toMatchObject({ testsInImage: true });
  expect(JSON.stringify(task.input)).not.toContain("private reference");
});

test("explicit verifier image precedes tests build definitions", async () => {
  const { task } = await prepare({ verifier: '[verifier.environment]\ndocker_image="grading:locked"\nmemory="2048m"\n',
    files: { "tests/Dockerfile": "FROM ignored:locked\n" } });
  expect(task.verifyEnv).toMatchObject({ image: "grading:locked", resources: { cpus: 2, memory: "2048m", storage: "10240m" } });
  expect(task.verifyEnv?.build).toBeUndefined();
  expect(task.verifyEnv?.services).toBeUndefined();
  expect(task.verification).toMatchObject({ testsInImage: true });
});

test("a prebuilt verifier keeps its private Compose services and overrides only the main build", async () => {
  const { task } = await prepare({ verifier: '[verifier.environment]\ndocker_image="grading:locked"\n', files: {
    "tests/docker-compose.yaml": "services:\n  main:\n    build: ./unshipped-main\n    depends_on: [database]\n  database:\n    image: database:locked\n    build: ./unshipped-database\n",
    "environment/docker-compose.yaml": "services:\n  main:\n    build: ./unshipped-agent\n  public-api:\n    image: public-api:locked\n",
  } });
  expect(task.solveEnv.image).toBe("agent:locked");
  expect(task.solveEnv.build).toBeUndefined();
  expect(task.solveEnv.services?.main?.build).toBeUndefined();
  expect(task.verifyEnv?.image).toBe("grading:locked");
  expect(task.verifyEnv?.build).toBeUndefined();
  expect(task.verifyEnv?.services?.main).toMatchObject({ image: "grading:locked", properties: { depends_on: ["database"] } });
  expect(task.verifyEnv?.services?.database?.image).toBe("database:locked");
  expect(task.verifyEnv?.services?.database?.build).toBeUndefined();
  expect(task.verifyEnv?.services).not.toHaveProperty("public-api");
});

test("a prebuilt verifier does not hide unsupported Compose capabilities", async () => {
  await expect(prepare({ verifier: '[verifier.environment]\ndocker_image="grading:locked"\n', files: {
    "tests/docker-compose.yaml": "services:\n  database:\n    image: database:locked\n    privileged: true\n",
  } })).rejects.toThrow("privileged");
});

test("published solve and verifier images take priority over both task Dockerfiles", async () => {
  const { task } = await prepare({ verifier: '[verifier.environment]\ndocker_image="grading@sha256:' + "b".repeat(64) + '"\n',
    files: { "environment/Dockerfile": "FROM should-not-build-agent\nRUN false\n",
      "tests/Dockerfile": "FROM should-not-build-grader\nRUN false\n" } });
  expect(task.solveEnv.image).toBe("agent:locked");
  expect(task.solveEnv.build).toBeUndefined();
  expect(task.verifyEnv?.image).toBe("grading@sha256:" + "b".repeat(64));
  expect(task.verifyEnv?.build).toBeUndefined();
  expect(task.verification).toMatchObject({ testsInImage: true });
});

test("a task without prebuilt image declarations falls back to its official Dockerfiles", async () => {
  const { task } = await prepare({ files: {
    "task.toml": '[environment]\nworkdir="/app"\n[verifier]\nenvironment_mode="separate"\n',
    "environment/Dockerfile": "FROM agent:base\nWORKDIR /app\n",
    "tests/Dockerfile": "FROM grading:base\nCOPY . /tests\n",
  } });
  expect(task.solveEnv).toMatchObject({ image: null, build: { dockerfile: "Dockerfile", visibility: "public" } });
  expect(task.verifyEnv).toMatchObject({ image: null, build: { dockerfile: "Dockerfile", visibility: "verifier" } });
});

test("resource-only verifier overrides retain a private tests build", async () => {
  const { task } = await prepare({ verifier: '[verifier.environment]\ncpus=1\n', files: { "tests/Dockerfile": "FROM grading:locked\n" } });
  expect(task.verifyEnv).toMatchObject({ resources: { cpus: 1, memory: "4096m" }, build: { visibility: "verifier" } });
});

test("separate mode discovers a private Compose verifier", async () => {
  const { root, task } = await prepare({ files: {
    "tests/docker-compose.yaml": "services:\n  main:\n    build: .\n  database:\n    image: database:locked\n",
    "tests/Dockerfile": "FROM grading:locked\nCOPY . /tests\n",
  } });
  expect(task.verifyEnv?.services?.main?.build).toMatchObject({ context: join(root, "tests"), visibility: "verifier" });
  expect(task.verifyEnv?.services?.database?.image).toBe("database:locked");
  expect(task.solveEnv.services).toBeUndefined();
});

test.each(["", '[verifier.environment]\nmemory="2048m"\n'])("separate mode falls back to the agent only without private definitions: %s", async verifier => {
  const { task } = await prepare({ verifier });
  expect(task.verifyEnv?.image).toBe("agent:locked");
  expect(task.verifyEnv?.resources?.memory).toBe(verifier ? "2048m" : "4096m");
  expect(task.verification).not.toHaveProperty("testsInImage");
});

test("a dedicated verifier executes image-baked tests without overwriting them", async () => {
  const { task } = await prepare({ files: { "tests/Dockerfile": "FROM grading:locked\nCOPY . /tests\n" } });
  const upload = vi.fn();
  let calls = 0;
  const handle = (stdout: string): ProcessHandle => ({ stdout: (async function* () { yield Buffer.from(stdout); })(),
    stderr: (async function* () {})(), done: Promise.resolve({ code: 0, signal: null }), async stop() {} });
  const session: EnvironmentSession = { id: "grading", workdir: "/app", agentOutputDir: "/logs/agent", verifierOutputDir: "/logs/verifier", metadata: {},
    upload, async start() { return handle(++calls === 1 ? "" : "txt\n0\n"); }, async download() {},
    async exportState() { throw new Error("unused"); }, async restoreState() {}, async dispose() {} };
  expect(await new HarborShellVerifier().verify(task.verification, session, signal())).toMatchObject({ rewards: { reward: 0 } });
  expect(upload).not.toHaveBeenCalled();
});

test.each(["", '[verifier.environment]\ndocker_image="grading:locked"\n[verifier.environment.healthcheck]\ncommand="connect-to-agent-port"\n'])(
  "TOML readiness gates the agent only, including a separate verifier declaration: %s", async verifier => {
    const { task } = await prepare({ files: {
      "task.toml": '[environment]\ndocker_image="agent:locked"\nworkdir="/app"\n[environment.healthcheck]\ncommand="agent-ready"\n[verifier]\nenvironment_mode="separate"\n' + verifier,
    } });
    expect(task.solveEnv.healthcheck?.command).toBe("agent-ready");
    expect(task.verifyEnv).not.toHaveProperty("healthcheck");
  });

test("unused verifier TOML healthcheck declarations are still validated", async () => {
  await expect(prepare({ verifier: '[verifier.environment]\ndocker_image="grading:locked"\n[verifier.environment.healthcheck]\ncommand="ready"\nretries=0\n' }))
    .rejects.toThrow("healthcheck.retries");
});
