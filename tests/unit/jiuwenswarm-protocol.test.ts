import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttemptContext, ProcessHandle } from "../../src/index.js";
import { validateSequence, type TrajectoryEvent } from "../../src/core/artifacts/trajectory.js";
import { consumeJiuwenswarm, parseJiuwenswarmEnvelope } from "../../src/runtimes/jiuwenswarm/protocol.js";

const roots: string[] = [];

async function context(name: string, signal = new AbortController().signal): Promise<AttemptContext> {
  const root = await mkdtemp(join(tmpdir(), `jiuwenswarm-protocol-${name}-`));
  roots.push(root);
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
  return { key: { runId: "run", taskId: name, attemptId: "attempt" }, paths, signal };
}

async function* bytes(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

function processHandle(options: { stdout?: string; stderr?: string; code?: number | null; signal?: string | null } = {}) {
  let stopped = 0;
  const handle: ProcessHandle = {
    stdout: bytes(options.stdout ?? ""),
    stderr: bytes(options.stderr ?? ""),
    done: Promise.resolve({ code: options.code ?? 0, signal: options.signal ?? null }),
    async stop() {
      stopped++;
    },
  };
  return { handle, stopped: () => stopped };
}

function envelope(ok: boolean, events: unknown[]): string {
  return `${JSON.stringify({ ok, session_id: "s", request_id: "r", events })}\n`;
}

function event(eventType: string, payload: Record<string, unknown>, ok = true): Record<string, unknown> {
  return { request_id: "r", channel_id: "process_cli", session_id: "s", payload: { event_type: eventType, ...payload }, agent_ref: null, metadata: {}, is_complete: false, ok };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("assembles delta and final text and maps usage counters", async () => {
  const value = await context("success");
  const stdout = envelope(true, [
    event("chat.delta", { delta: "答案是 " }),
    event("chat.delta", { content: "2" }),
    event("chat.final", { answer: "答案是 2" }),
    event("chat.usage_summary", { usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } }),
    { request_id: "r", channel_id: "process_cli", session_id: "s", payload: null, agent_ref: null, metadata: {}, is_complete: true, ok: true },
  ]);
  const process = processHandle({ stdout, stderr: "runtime started" });

  const result = await consumeJiuwenswarm(process.handle, value, "");

  expect(result).toEqual({ finalText: "答案是 2", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } });
  expect(await readFile(join(value.paths.agent, "stderr.log"), "utf8")).toBe("runtime started");
  expect(JSON.parse(await readFile(join(value.paths.agent, "session.jsonl"), "utf8"))).toMatchObject({
    schemaVersion: 1,
    exitCode: 0,
    usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
  });
  const trajectory = (await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8"))
    .trimEnd()
    .split(String.fromCharCode(10))
    .map(line => JSON.parse(line) as TrajectoryEvent);
  expect(trajectory.map(event => event.type)).toEqual(["start", "text", "usage", "end"]);
  expect(trajectory[1]?.data).toEqual({ text: "答案是 2" });
  expect(validateSequence(trajectory)).toEqual({ complete: true, missing: [] });
  expect(process.stopped()).toBe(0);
});

test("preserves native tool diagnostics in order and coalesces streaming text", async () => {
  const value = await context("tools");
  const stdout = envelope(true, [
    ...[..."Checking source."].map(delta => event("chat.delta", { delta })),
    event("chat.final", { content: "Checking source." }),
    event("chat.tool_call", { tool_call: { name: "read_file", arguments: '{"file_path":"/workspace/input/demo.txt"}', tool_call_id: "c1" } }),
    event("chat.tool_result", { tool_name: "read_file", tool_call_id: "c1", result: "compatibility display", rendered_result: "field missing", success: false, status: "error", is_error: true }),
    event("tool.use", { name: "bash", arguments: { command: "ls /workspace/output" }, id: "c2" }),
    event("tool.result", { tool_name: "bash", tool_call_id: "c2", result: { files: ["demo.xlsx"] }, success: true }),
    event("chat.delta", { content: "Saved " }),
    event("chat.final", { content: "Saved demo.xlsx" }),
  ]);

  await consumeJiuwenswarm(processHandle({ stdout }).handle, value, "");

  const trajectory = (await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8"))
    .trimEnd().split("\n").map(line => JSON.parse(line) as TrajectoryEvent);
  expect(trajectory.map(event => event.type)).toEqual(["start", "text", "tool_call", "tool_result", "tool_call", "tool_result", "text", "usage", "end"]);
  expect(trajectory.slice(1, 7).map(event => event.data)).toEqual([
    { text: "Checking source." },
    { tool: "read_file", callId: "c1", input: { file_path: "/workspace/input/demo.txt" } },
    { tool: "read_file", callId: "c1", status: "error", result: "field missing" },
    { tool: "bash", callId: "c2", input: { command: "ls /workspace/output" } },
    { tool: "bash", callId: "c2", status: "completed", result: { files: ["demo.xlsx"] } },
    { text: "Saved demo.xlsx" },
  ]);
  expect(validateSequence(trajectory)).toEqual({ complete: true, missing: [] });
});

test("redacts nested tool arguments, results and identifiers before writing diagnostics", async () => {
  const value = await context("redact-tools");
  const secret = 'credential/with+"quote';
  const encoded = encodeURIComponent(secret);
  const stdout = envelope(true, [
    event("chat.tool_call", { tool_call: { name: `tool-${secret}`, tool_call_id: encoded, arguments: JSON.stringify({ [secret]: [{ value: secret }, { url: encoded }] }) } }),
    event("chat.tool_result", { tool_name: secret, tool_call_id: encoded, raw_output: { items: [secret, encoded] }, success: true }),
    event("chat.final", { content: "Done" }),
  ]);

  await consumeJiuwenswarm(processHandle({ stdout }).handle, value, secret);

  const text = await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8");
  expect(text).not.toContain(encoded);
  const trajectory = text.trimEnd().split("\n").map(line => JSON.parse(line) as TrajectoryEvent);
  expect(trajectory[1]?.data).toEqual({ tool: "tool-[redacted]", callId: "[redacted]", input: { "[redacted]": [{ value: "[redacted]" }, { url: "[redacted]" }] } });
  expect(trajectory[2]?.data).toEqual({ tool: "[redacted]", callId: "[redacted]", status: "completed", result: { items: ["[redacted]", "[redacted]"] } });
});

test("reports a runtime error envelope even when the process exits 0", async () => {
  const value = await context("runtime-error");
  const stdout = envelope(false, [
    event("runtime.error", { error: "No valid model entries found in config", execution_id: "e" }, false),
  ]);
  const process = processHandle({ stdout });

  await expect(consumeJiuwenswarm(process.handle, value, "")).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
  });
});

test("maps only the process CLI's explicit deadline to a solve phase timeout and preserves diagnostics", async () => {
  const value = await context("phase-timeout");
  const stdout = envelope(false, [
    event("chat.delta", { content: "Partial work" }),
    event("runtime.error", { error: "process CLI execution timed out" }, false),
  ]);
  const process = processHandle({ stdout, stderr: "runtime cancelled", code: 124 });

  await expect(consumeJiuwenswarm(process.handle, value, "")).rejects.toMatchObject({
    name: "PhaseTimeoutError", code: "SOLVER_AGENT_TIMEOUT", phase: "solve",
    message: "jiuwenswarm reported an error: process CLI execution timed out",
    cause: { code: "INTERNAL_ERROR" },
  });
  const trajectory = (await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8"))
    .trimEnd().split("\n").map(line => JSON.parse(line) as TrajectoryEvent);
  expect(trajectory.map(item => item.type)).toEqual(["start", "text", "error"]);
  expect(trajectory.at(-1)?.data).toMatchObject({ code: "SOLVER_AGENT_TIMEOUT" });
  expect(await readFile(join(value.paths.agent, "stderr.log"), "utf8")).toBe("runtime cancelled");
  expect(process.stopped()).toBe(1);
});

test.each(["recovery-exhausted", "iteration-budget-exhausted"])(
  "returns actual output for the native empty-length guard's typed %s event", async reason => {
    const value = await context("output-truncated");
    const message = `EMPTY_TRUNCATED_MODEL_RESPONSE: ${reason}; recovery limit=1`;
    const stdout = envelope(false, [event("chat.delta", { content: "partial" }),
      event("chat.error", { error_type: "EmptyLengthResponseError", error: message })]);
    const process = processHandle({ stdout, stderr: "local guard fixture" });
    const warnings: unknown[] = [];
    const result = await consumeJiuwenswarm(process.handle, { ...value, warning: warning => warnings.push(warning) }, "");
    expect(result.finalText).toBe("partial");
    expect(warnings).toEqual([expect.objectContaining({ code: "SOLVER_OUTPUT_LIMIT", message: expect.stringContaining(message) })]);
    const trajectory = (await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8"))
      .trimEnd().split("\n").map(line => JSON.parse(line) as TrajectoryEvent);
    expect(trajectory.some(item => item.type === "error")).toBe(false);
    expect(trajectory.at(-1)?.data).toMatchObject({ status: "completed", finalText: "partial" });
    expect(await readFile(join(value.paths.agent, "stderr.log"), "utf8")).toBe("local guard fixture");
  },
);

test.each(["runtime-error", "crash", "signal", "cancelled"])("does not hide %s after a typed truncation", async scenario => {
  const value = await context("truncated-failure");
  const stdout = envelope(false, [event("chat.error", { error_type: "EmptyLengthResponseError",
    error: "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-exhausted; recovery limit=1" }),
  ...(scenario === "runtime-error" ? [event("runtime.error", { error: "AuthenticationError: invalid api key" }, false)] : [])]);
  const signal = scenario === "cancelled" ? AbortSignal.abort(new DOMException("cancelled", "AbortError")) : value.signal;
  await expect(consumeJiuwenswarm(processHandle({ stdout, code: scenario === "crash" ? 137 : 0,
    signal: scenario === "signal" ? "SIGTERM" : null }).handle, { ...value, signal }, ""))
    .rejects.toMatchObject(scenario === "cancelled" ? { name: "AbortError" }
      : { code: scenario === "runtime-error" ? "INTERNAL_ERROR" : "SOLVER_PROCESS_CRASHED" });
});

test.each([
  event("chat.error", { error: "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-exhausted; recovery limit=1" }),
  event("chat.error", { error_type: "OtherError", error: "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-exhausted; recovery limit=1" }),
  event("runtime.error", { error_type: "EmptyLengthResponseError", error: "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-exhausted; recovery limit=1" }),
  event("chat.error", { error_type: "EmptyLengthResponseError", error: "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-context-unavailable; recovery limit=1" }),
  event("chat.error", { error_type: "EmptyLengthResponseError", error: "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-context-update-failed; recovery limit=1" }),
  event("chat.error", { error_type: "EmptyLengthResponseError", error: "quoted EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-exhausted; recovery limit=1" }),
  event("chat.error", { error_type: "EmptyLengthResponseError", error: "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-exhausted; recovery limit=2" }),
  event("chat.error", { error_type: "EmptyLengthResponseError", error: "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-exhausted; recovery limit=1 HTTP 400" }),
  { ...event("chat.error", { error_type: "EmptyLengthResponseError", error: "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-exhausted; recovery limit=1" }), channel_id: "other" },
])("does not turn untyped markers, context failures or other events into output truncation", async failure => {
  const value = await context("not-output-truncated");
  await expect(consumeJiuwenswarm(processHandle({ stdout: envelope(false, [failure]) }).handle, value, ""))
    .rejects.toMatchObject({ code: "INTERNAL_ERROR" });
});

test.each([
  event("chat.error", { error: "process CLI execution timed out" }, false),
  event("runtime.error", { error: "upstream model timeout" }, false),
  event("runtime.error", { error: "AuthenticationError: request timed out" }, false),
  { ...event("runtime.error", { error: "process CLI execution timed out" }, false), channel_id: "other" },
])("does not normalize unrelated or permanent errors to a phase timeout", async failure => {
  const value = await context("unrelated-timeout");
  await expect(consumeJiuwenswarm(processHandle({ stdout: envelope(false, [failure]) }).handle, value, ""))
    .rejects.toMatchObject({ code: "INTERNAL_ERROR" });
});

test("a later deadline does not overwrite the original runtime failure", async () => {
  const value = await context("first-error");
  const stdout = envelope(false, [
    event("chat.error", { error: "AuthenticationError: invalid api key" }, false),
    event("runtime.error", { error: "process CLI execution timed out" }, false),
  ]);
  await expect(consumeJiuwenswarm(processHandle({ stdout }).handle, value, ""))
    .rejects.toMatchObject({ code: "INTERNAL_ERROR", message: expect.stringContaining("AuthenticationError") });
});

test("gates on a nonzero exit code", async () => {
  const value = await context("exited");
  const stdout = envelope(true, [event("chat.final", { answer: "partial" })]);
  const process = processHandle({ stdout, code: 3 });

  await expect(consumeJiuwenswarm(process.handle, value, "")).rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
});

test("keeps usage unknown without a usage summary and redacts the credential", async () => {
  const value = await context("redact");
  const secret = "jiuwenswarm/secret+canary";
  const stdout = envelope(true, [event("chat.final", { answer: `final ${secret}` })]);
  const process = processHandle({ stdout, stderr: `stderr ${secret}` });

  const result = await consumeJiuwenswarm(process.handle, value, secret);

  expect(result).toEqual({ finalText: "final [redacted]", usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
  expect(await readFile(join(value.paths.agent, "stderr.log"), "utf8")).not.toContain(secret);
});

test("stops the process and keeps the error when cancelled", async () => {
  const controller = new AbortController();
  const value = await context("cancel", controller.signal);
  const release = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>();
  let stopped = 0;
  const stdout = (async function* () {
    yield Buffer.from("partial", "utf8");
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

  const consuming = consumeJiuwenswarm(handle, value, "");
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort(new DOMException("cancelled", "AbortError"));

  await expect(consuming).rejects.toMatchObject({ name: "AbortError" });
  expect(stopped).toBe(1);
});

test("parses a terminal envelope from multi-record output", () => {
  const text = `[diag] bootstrap\n${envelope(true, [event("chat.final", { answer: "ok" })])}`;
  expect(parseJiuwenswarmEnvelope(text).ok).toBe(true);
  expect(parseJiuwenswarmEnvelope(text).events).toHaveLength(1);
});
