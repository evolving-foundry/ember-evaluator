import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttemptContext, ProcessHandle } from "../../src/index.js";
import { consumeHermes } from "../../src/runtimes/hermes/protocol.js";
import { validateSequence, type TrajectoryEvent } from "../../src/core/artifacts/trajectory.js";

const roots: string[] = [];

async function context(name: string, signal = new AbortController().signal): Promise<AttemptContext> {
  const root = await mkdtemp(join(tmpdir(), `hermes-protocol-${name}-`));
  roots.push(root);
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
  return { key: { runId: "run", taskId: name, attemptId: "attempt" }, paths, signal };
}

async function* bytes(value: string, cuts: number[] = []): AsyncIterable<Uint8Array> {
  let offset = 0;
  for (const length of cuts) {
    yield Buffer.from(value.slice(offset, offset + length), "utf8");
    offset += length;
  }
  if (offset < value.length) yield Buffer.from(value.slice(offset), "utf8");
}

function processHandle(options: { stdout?: string; stderr?: string; code?: number | null; signal?: string | null } = {}) {
  let stopped = 0;
  const handle: ProcessHandle = {
    stdout: bytes(options.stdout ?? ""),
    stderr: bytes(options.stderr ?? ""),
    done: Promise.resolve({ code: options.code ?? 0, signal: options.signal ?? null }),
    async stop() { stopped++; },
  };
  return { handle, stopped: () => stopped };
}

async function writeUsage(root: string, value: unknown): Promise<string> {
  const target = join(root, "usage.json");
  await writeFile(target, JSON.stringify(value));
  return target;
}

async function evidence(value: AttemptContext) {
  const session = await readFile(join(value.paths.agent, "session.jsonl"), "utf8");
  const trajectoryText = await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8");
  const trajectory = trajectoryText.trimEnd().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line) as TrajectoryEvent);
  const stderr = await readFile(join(value.paths.agent, "stderr.log"), "utf8");
  return { session, trajectory, stderr };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("treats exit 0 as success, synthesizes the trajectory, and maps the usage file", async () => {
  const value = await context("success");
  const usagePath = await writeUsage(value.paths.agent, { input_tokens: 12, output_tokens: 5, total_tokens: 17, cache_read_tokens: 2, cache_write_tokens: 1 });
  const process = processHandle({ stdout: "Answer: 42", stderr: "model cache hit" });

  const result = await consumeHermes(process.handle, value, "", usagePath);

  expect(result).toEqual({ finalText: "Answer: 42", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } });
  const saved = await evidence(value);
  expect(saved.trajectory.map(event => event.type)).toEqual(["start", "usage", "end"]);
  expect(validateSequence(saved.trajectory)).toEqual({ complete: true, missing: [] });
  expect(JSON.parse(saved.session).exitCode).toBe(0);
  expect(saved.stderr).toBe("model cache hit");
  expect(process.stopped()).toBe(0);
});

test("gates on a nonzero exit code and never reads stdout as the answer (H4)", async () => {
  const value = await context("failed");
  const usagePath = await writeUsage(value.paths.agent, { completed: false });
  const process = processHandle({ stdout: "hermes exploded here", stderr: "traceback", code: 2 });

  await expect(consumeHermes(process.handle, value, "", usagePath)).rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
  const saved = await evidence(value);
  expect(saved.trajectory.some(event => event.type === "end")).toBe(false);
  expect(saved.trajectory.some(event => event.type === "error")).toBe(true);
  expect(saved.session).not.toContain("hermes exploded");
});

test.each([{ code: 1, signal: null }, { code: 137, signal: null }, { code: 2, signal: "SIGTERM" }])(
  "rejects abnormal exit $code/$signal even with captured length evidence", async exit => {
    const value = await context("truncated-exit");
    const report = await writeUsage(value.paths.agent, { evaluator_output: { finishReason: "length", finalText: "partial" } });
    await expect(consumeHermes(processHandle({ ...exit, stdout: "partial" }).handle, value, "", report))
      .rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
  },
);

test("rejects an empty answer (exit 1) instead of returning a blank result", async () => {
  const value = await context("empty");
  const usagePath = await writeUsage(value.paths.agent, { completed: false });
  const process = processHandle({ stdout: "", stderr: "no answer", code: 1 });

  await expect(consumeHermes(process.handle, value, "", usagePath)).rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
  const saved = await evidence(value);
  expect(saved.trajectory.some(event => event.type === "end")).toBe(false);
});

test("keeps usage unknown when the usage file is missing", async () => {
  const value = await context("unknown-usage");
  const process = processHandle({ stdout: "done" });

  const result = await consumeHermes(process.handle, value, "", join(value.paths.agent, "usage.json"));
  expect(result).toEqual({ finalText: "done", usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
  expect(validateSequence((await evidence(value)).trajectory)).toEqual({ complete: true, missing: [] });
});

test("rejects an interrupted exit (SIGINT, code 130)", async () => {
  const value = await context("interrupt");
  const usagePath = await writeUsage(value.paths.agent, { completed: false });
  const process = processHandle({ stdout: "", stderr: "interrupted", code: 130 });
  await expect(consumeHermes(process.handle, value, "", usagePath)).rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
});

test("redacts the credential from stdout, stderr, and the synthesized evidence", async () => {
  const value = await context("redact");
  const secret = "hermes/secret+canary";
  const encoded = encodeURIComponent(secret);
  const usagePath = await writeUsage(value.paths.agent, { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
  const process = processHandle({ stdout: `final ${secret}`, stderr: `stderr ${secret} ${encoded}` });

  const result = await consumeHermes(process.handle, value, secret, usagePath);
  expect(result.finalText).not.toContain(secret);
  const saved = await evidence(value);
  expect(saved.session + JSON.stringify(saved.trajectory) + saved.stderr).not.toContain(secret);
  expect(saved.stderr).toBe("stderr [redacted] [redacted]");
});

test("stops the process and retains partial evidence when cancelled", async () => {
  const controller = new AbortController();
  const value = await context("cancel", controller.signal);
  const usagePath = await writeUsage(value.paths.agent, { completed: false });
  const release = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>();
  let stopped = 0;
  const stdout = (async function* () {
    yield Buffer.from("partial answer", "utf8");
    await release.promise;
  })();
  const handle: ProcessHandle = {
    stdout,
    stderr: bytes("partial stderr"),
    done: exited.promise,
    async stop() {
      stopped++;
      release.resolve();
      exited.resolve({ code: null, signal: "SIGTERM" });
    },
  };

  const consuming = consumeHermes(handle, value, "", usagePath);
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort(new DOMException("cancelled", "AbortError"));

  await expect(consuming).rejects.toMatchObject({ name: "AbortError" });
  expect(stopped).toBe(1);
  const saved = await evidence(value);
  expect(saved.trajectory.some(event => event.type === "end")).toBe(false);
});
