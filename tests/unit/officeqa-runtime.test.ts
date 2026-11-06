import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { officeQAVerificationRuntime } from "../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime/runtime.js";
import type { PreparedTask } from "../../src/core/contracts/task.js";

const mocks = vi.hoisted(() => ({ output: '{"score":1}', code: 0, create: vi.fn(), dispose: vi.fn(), input: "", command: [] as string[], cancelled: false }));
vi.mock("../../src/plugins/verifiers/shared/container.js", () => ({
  materializeVerifierImage: async () => `sha256:${"a".repeat(64)}`,
  recoverVerifierContainers: vi.fn(),
  createVerifierContainer: async (...args: unknown[]) => {
    mocks.create(...args); mocks.command = args[3] as string[];
    return { metadata: { kind: "fixture" }, dispose: mocks.dispose,
      start(signal: AbortSignal) {
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        stdin.on("data", chunk => { mocks.input += String(chunk); });
        const done = new Promise<number>(resolve => stdin.on("finish", () => {
          if (mocks.cancelled) { if (signal.aborted) resolve(0); else signal.addEventListener("abort", () => resolve(0), { once: true }); return; }
          stdout.end(mocks.output); stderr.end("fixture diagnostic"); resolve(mocks.code);
        }));
        return { worker: { stdin, stdout, stderr }, done };
      } };
  },
}));
afterEach(() => { vi.clearAllMocks(); mocks.output = '{"score":1}'; mocks.code = 0; mocks.input = ""; mocks.cancelled = false; });
const task: PreparedTask = { input: { id: "qid_7", prompt: "question" }, verification: { answer: "private-value", tolerance: 0, corpusFormat: "pdf" },
  solveEnv: { workdir: "/workspace", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null };
const result = { finalText: "prediction", usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
async function session() {
  const runtime = officeQAVerificationRuntime("docker"); const signal = new AbortController().signal;
  return runtime.prepare(task, await runtime.materialize(task, signal), { key: { runId: "run", taskId: "qid_7", attemptId: "attempt" },
    paths: { root: ".", agent: ".", verifier: ".", artifacts: "." }, signal });
}
test("private scorer uses stdin and returns official version details", async () => {
  const handle = await session();
  expect(await handle.verify(result, null, new AbortController().signal)).toMatchObject({ score: 1, passed: true, details: { tolerance: 0, corpusFormat: "pdf" } });
  expect(JSON.parse(mocks.input)).toEqual({ answer: "private-value", prediction: "prediction", tolerance: 0 });
  expect(mocks.command.join(" ")).not.toContain("private-value");
  expect(mocks.create.mock.calls[0]?.[2]).toContain("none");
  await handle.dispose(new AbortController().signal); expect(mocks.dispose).toHaveBeenCalledOnce();
});
test.each([[0, "{}"], [0, "broken"], [0, '{"score":0.5}'], [1, '{"score":0}'], [125, ""], [0, "x".repeat(5000)]])("scoring infrastructure failure never becomes zero: exit=%s", async (code, output) => {
  mocks.code = Number(code); mocks.output = String(output);
  const handle = await session();
  try { await expect(handle.verify(result, null, new AbortController().signal)).rejects.toThrow(); }
  finally { await handle.dispose(new AbortController().signal); }
  expect(mocks.dispose).toHaveBeenCalledOnce();
});
test("cancelled scoring remains cancelled and releases its container", async () => {
  mocks.cancelled = true; const handle = await session(); const controller = new AbortController();
  const verification = handle.verify(result, null, controller.signal); controller.abort(new Error("cancelled scoring"));
  await expect(verification).rejects.toThrow("cancelled scoring");
  await handle.dispose(new AbortController().signal); expect(mocks.dispose).toHaveBeenCalledOnce();
});
