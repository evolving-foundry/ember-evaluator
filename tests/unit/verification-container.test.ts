import type { SpawnOptions } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { humanevalDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/humaneval.js";
import { createVerifierContainer, materializeVerifierImage } from "../../src/plugins/verifiers/shared/container.js";

const state = vi.hoisted(() => ({ calls: [] as string[][], missing: false, started: true, removalError: false,
  exitCode: 0, script: "", image: "sha256:" + "a".repeat(64) }));
vi.mock("../../src/infrastructure/containers/command.js", () => ({
  runDockerCommand: async (_docker: string, args: string[]) => {
    state.calls.push(args);
    if (args[0] === "version") return { stdout: "linux/amd64", stderr: "" };
    if (args[0] === "pull") { state.missing = false; return { stdout: "", stderr: "" }; }
    if (args[0] === "image") { if (state.missing) throw new Error("No such image"); return { stdout: state.image, stderr: "" }; }
    if (args[0] === "rm" && state.removalError) throw new Error("Docker unavailable");
    if (args[0] === "container") return { stdout: JSON.stringify({ Status: state.started ? "exited" : "created",
      ExitCode: state.exitCode, Error: "", StartedAt: state.started ? "2026-10-24T00:00:00Z" : "0001-01-01T00:00:00Z" }), stderr: "" };
    return { stdout: "created", stderr: "" };
  },
}));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (_executable: string, args: string[], options: SpawnOptions) => {
    state.calls.push(args);
    return actual.spawn(process.execPath, ["-e", state.script || `process.stdin.resume(); process.stdin.on('end', () => process.exit(${state.exitCode}));`], options);
  } };
});
afterEach(() => { state.calls.length = 0; state.missing = false; state.started = true; state.removalError = false; state.exitCode = 0; state.script = ""; });
const key = { runId: "run", taskId: "task", attemptId: "attempt" };
const paths = { root: ".", agent: ".", verifier: ".", artifacts: "." };
const solved = { finalText: "    return 42", usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
const signal = () => AbortSignal.timeout(5000);

test("missing verifier images are pulled during materialization and resolved to immutable IDs", async () => {
  state.missing = true;
  expect(await materializeVerifierImage("fixture", "python:3.12-slim", signal())).toBe(state.image);
  expect(state.calls.map(args => args[0])).toEqual(["image", "version", "pull", "image"]);
});

test.each([0, 1])("HumanEval requires completed tests in a prepared, labelled offline container (exit %s)", async code => {
  state.exitCode = code;
  state.script = `let input=''; process.stdin.on('data', chunk => input+=chunk); process.stdin.on('end', () => {
    if (!input.includes('def answer():') || !input.includes('return 42') || !input.includes('check(answer)')) process.exit(99);
    if (${code} === 0) { const marker = input.match(/HUMANEVAL_COMPLETED_[a-f0-9-]+/)[0]; process.stdout.write(marker+'\\n'); }
    process.exit(${code}); });`;
  const runtime = humanevalDefinition.verificationRuntime!({ dockerExecutable: "fixture" });
  const defined = humanevalDefinition.prepare("task", { selection: "test", value: { prompt: "def answer():\n", test: "def check(f): assert f() == 42", entry_point: "answer" } }, 0, null);
  const task = { ...defined, solveEnv: { workdir: ".", image: null, runtime: [], initialFiles: [] }, verifyEnv: null, transfer: null };
  const receipt = await runtime.materialize(task, signal());
  expect(state.calls.map(args => args[0])).toEqual(["image"]);
  const handle = await runtime.prepare(task, receipt, { key, paths, signal: signal() });
  const creation = state.calls.find(args => args[0] === "create")!;
  expect(creation).toEqual(expect.arrayContaining(["--pull", "never", "--network", "none", "--read-only", "--pids-limit", "64", state.image,
    "ember.run=run", "ember.task=task", "ember.attempt=attempt", "ember.phase=verify"]));
  expect(state.calls.some(args => args[0] === "start")).toBe(false);
  try { expect(await handle.verify(solved, null, signal())).toMatchObject({ score: code === 0 ? 1 : 0, passed: code === 0, details: { timedOut: false } }); }
  finally { await handle.dispose(signal()); }
  expect(state.calls.filter(args => args[0] === "rm")).toHaveLength(1);
  expect(state.calls.some(args => args[0] === "pull" || args[0] === "build" || args[0] === "run")).toBe(false);
});

test("a Docker attach failure is not accepted as a program exit", async () => {
  state.started = false;
  const container = await createVerifierContainer("fixture", state.image, [], ["python", "-"], key, signal());
  const { worker, done } = container.start(signal()); worker.stdin.end();
  try { await expect(done).rejects.toThrow("not an execution result"); }
  finally { await container.dispose(signal()); }
});

test("HumanEval exit zero without a completion marker is a failed answer", async () => {
  const runtime = humanevalDefinition.verificationRuntime!({ dockerExecutable: "fixture" });
  const defined = humanevalDefinition.prepare("task", { selection: "test", value: {
    prompt: "def answer():\n", test: "def check(f): assert f() == 42", entry_point: "answer",
  } }, 0, null);
  const task = { ...defined, solveEnv: { workdir: ".", image: null, runtime: [], initialFiles: [] }, verifyEnv: null, transfer: null };
  const receipt = await runtime.materialize(task, signal());
  const handle = await runtime.prepare(task, receipt, { key, paths, signal: signal() });
  try {
    expect(await handle.verify(solved, null, signal())).toMatchObject({ score: 0, passed: false, details: { exitCode: 0, testsCompleted: false } });
  } finally { await handle.dispose(signal()); }
});

test("cancellation stops the client and disposal removes the named container", async () => {
  state.script = "process.stdin.resume(); setInterval(() => {}, 1000);";
  const container = await createVerifierContainer("fixture", state.image, [], [], key, signal());
  const cancel = new AbortController();
  const { done } = container.start(cancel.signal); cancel.abort(); await done;
  await container.dispose(signal());
  const name = state.calls.find(args => args[0] === "create")![4];
  expect(state.calls.find(args => args[0] === "rm")?.at(-1)).toBe(name);
});

test("unconfirmed removal rejects disposal instead of reporting success", async () => {
  const container = await createVerifierContainer("fixture", state.image, [], [], key, signal());
  state.removalError = true;
  await expect(container.dispose(AbortSignal.timeout(20))).rejects.toThrow();
});
