import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptContext, ProcessHandle } from "../../src/index.js";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";

const roots: string[] = [];
async function context(): Promise<AttemptContext> {
  const root = await mkdtemp(join(tmpdir(), "dsh-protocol-"));
  roots.push(root);
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
  return { key: { runId: "run", taskId: "task", attemptId: "attempt" }, paths, signal: new AbortController().signal };
}
async function* bytes(text: string) { yield Buffer.from(text); }
const opening = [
  { type: "session", sessionId: "session", cwd: "/workspace" },
  { type: "status", phase: "turn_start", turn: 1 },
  { type: "status", phase: "step_start", turn: 1, step: 1 },
];
const closing = [
  { type: "status", phase: "step_end", turn: 1, step: 1 },
  { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
];
function handle(records: unknown[], code = 0): ProcessHandle {
  return { stdout: bytes(records.map(value => JSON.stringify(value)).join("\n") + "\n"), stderr: bytes(""),
    done: Promise.resolve({ code, signal: null }), async stop() {} };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each([{ label: "DSH", code: 1 }, { label: "DSH", code: 0 }, { label: "DEEPAGENTS", code: 0 }])(
  "returns truncated output with a warning for $label exit $code", async ({ label, code }) => {
    const value = await context();
    const warnings: unknown[] = [];
    const result = await consumeDsh(handle([...opening,
      { type: "text", text: "partial answer" }, closing[0],
      { type: "status", phase: "turn_end", turn: 1, reason: { kind: "max-tokens" } },
      { type: "final", text: "partial answer" }], code),
    { ...value, warning: warning => warnings.push(warning) }, "", undefined, label);
    expect(result.finalText).toBe("partial answer");
    expect(warnings).toEqual([expect.objectContaining({ code: "SOLVER_OUTPUT_LIMIT" })]);
    const trajectory = await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8");
    expect(trajectory).toContain('"type":"warning"');
    expect(trajectory).toContain('"reason":{"kind":"max-tokens"}');
    expect(trajectory).toContain('"status":"completed"');
  },
);

test.each(["", "partial answer"])("allows actual truncated final text %j", async finalText => {
  const result = await consumeDsh(handle([...opening, closing[0],
    { type: "status", phase: "turn_end", turn: 1, reason: { kind: "max-tokens" } },
    { type: "final", text: finalText }], 1), await context(), "");
  expect(result.finalText).toBe(finalText);
});

test.each(["missing-final", "crash", "signal", "later-error"])("does not hide %s after truncation", async scenario => {
  const records = [...opening, closing[0],
    { type: "status", phase: "turn_end", turn: 1, reason: { kind: "max-tokens" } },
    ...(scenario === "later-error" ? [{ type: "error", message: "authentication failed" }] : []),
    ...(scenario === "missing-final" ? [] : [{ type: "final", text: "partial" }])];
  const process = handle(records, scenario === "crash" ? 137 : 0);
  if (scenario === "signal") process.done = Promise.resolve({ code: 0, signal: "SIGTERM" });
  await expect(consumeDsh(process, await context(), "")).rejects.toMatchObject({
    code: scenario === "missing-final" ? "SOLVER_PROTOCOL_INVALID"
      : scenario === "later-error" ? "INTERNAL_ERROR" : "SOLVER_PROCESS_CRASHED",
  });
});

test("accepts DSH's completed turn followed by an empty next turn and final", async () => {
  const value = await context();
  const result = await consumeDsh(handle([...opening, ...closing,
    { type: "status", phase: "turn_start", turn: 2 }, { type: "final", text: "answer" }]), value, "");
  expect(result.finalText).toBe("answer");
});

test("does not use an earlier completed turn to accept a partially executed next turn", async () => {
  await expect(consumeDsh(handle([...opening, ...closing,
    { type: "status", phase: "turn_start", turn: 2 },
    { type: "status", phase: "step_start", turn: 2, step: 1 },
    { type: "final", text: "answer" }]), await context(), ""))
    .rejects.toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
});

test("keeps the full output reference and the real status with concurrent pending calls", async () => {
  const value = await context();
  const text = "complete output\n".repeat(20000);
  await mkdir(join(value.paths.agent, "tool-outputs"));
  await writeFile(join(value.paths.agent, "tool-outputs", "call.txt"), text);
  const event = { type: "tool_result", callId: "call", status: "error", result: "preview", truncated: true,
    originalBytes: Buffer.byteLength(text), resultRef: "agent/tool-outputs/call.txt",
    sha256: createHash("sha256").update(text).digest("hex") };
  const result = await consumeDsh(handle([...opening,
    { type: "tool_call", callId: "call", tool: "bash", input: { command: "large output" } },
    { type: "tool_call", callId: "second", tool: "bash", input: {} },
    event,
    { type: "tool_result", callId: "second", status: "completed", result: "ok" },
    ...closing, { type: "final", text: "answer" }]), value, "");
  expect(result.finalText).toBe("answer");
  const trajectory = await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8");
  expect(trajectory).toContain('"truncated":true');
  expect(trajectory).toContain('"callId":"call"');
  expect(trajectory).toContain('"status":"error"');
  expect(trajectory).toContain('"resultRef":"agent/tool-outputs/call.txt"');
  const session = await readFile(join(value.paths.agent, "session.jsonl"), "utf8");
  expect(session).toContain(JSON.stringify(event));
});

test("never guesses a call or outcome from a bare truncated result", async () => {
  await expect(consumeDsh(handle([...opening,
    { type: "tool_call", callId: "call", tool: "bash", input: {} },
    { type: "tool_result", truncated: true }]), await context(), ""))
    .rejects.toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
});

test.each(["missing", "checksum", "size", "escape", "symlink", "metadata", "no-reference"])("rejects %s tool output evidence", async kind => {
  const value = await context();
  const directory = join(value.paths.agent, "tool-outputs");
  await mkdir(directory);
  const text = "full text";
  const event: Record<string, unknown> = { type: "tool_result", callId: "call", status: "completed", result: "preview",
    truncated: true, originalBytes: Buffer.byteLength(text), storedBytes: Buffer.byteLength(text),
    resultRef: "agent/tool-outputs/call.txt", sha256: createHash("sha256").update(text).digest("hex") };
  if (kind !== "missing") await writeFile(join(directory, "call.txt"), text);
  if (kind === "checksum") event.sha256 = "0".repeat(64);
  if (kind === "size") event.storedBytes = 1;
  if (kind === "escape") event.resultRef = "agent/tool-outputs/../../private.txt";
  if (kind === "metadata") delete event.sha256;
  if (kind === "no-reference") {
    for (const key of ["resultRef", "sha256", "originalBytes", "storedBytes"]) delete event[key];
  }
  if (kind === "symlink") {
    const external = join(value.paths.root, "external");
    await mkdir(external);
    await writeFile(join(external, "call.txt"), text);
    await rm(directory, { recursive: true });
    await symlink(external, directory, "junction");
  }
  await expect(consumeDsh(handle([...opening, { type: "tool_call", callId: "call", tool: "bash", input: {} },
    event, ...closing, { type: "final", text: "answer" }]), value, ""))
    .rejects.toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
});

test("an abnormal exit retains already verified output evidence", async () => {
  const value = await context();
  await mkdir(join(value.paths.agent, "tool-outputs"));
  await writeFile(join(value.paths.agent, "tool-outputs", "call.txt"), "retained");
  await expect(consumeDsh(handle([...opening,
    { type: "tool_call", callId: "call", tool: "bash", input: {} },
    { type: "tool_result", callId: "call", status: "completed", result: "preview", truncated: true,
      originalBytes: 8, resultRef: "agent/tool-outputs/call.txt", sha256: createHash("sha256").update("retained").digest("hex") },
  ], 137), value, "")).rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
  expect(await readFile(join(value.paths.agent, "tool-outputs", "call.txt"), "utf8")).toBe("retained");
  expect(await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8")).toContain('"resultRef"');
});

test("cancellation keeps output files and the reference received before stopping", async () => {
  const value = await context();
  const controller = new AbortController();
  await mkdir(join(value.paths.agent, "tool-outputs"));
  await writeFile(join(value.paths.agent, "tool-outputs", "call.txt"), "retained");
  const records = [...opening, { type: "tool_call", callId: "call", tool: "bash", input: {} },
    { type: "tool_result", callId: "call", status: "completed", result: "preview", truncated: true,
      originalBytes: 8, resultRef: "agent/tool-outputs/call.txt", sha256: createHash("sha256").update("retained").digest("hex") }];
  const process = handle([]);
  process.stdout = (async function* () {
    yield Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
    controller.abort(new DOMException("cancelled", "AbortError"));
  })();
  await expect(consumeDsh(process, { ...value, signal: controller.signal }, "")).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(join(value.paths.agent, "tool-outputs", "call.txt"), "utf8")).toBe("retained");
  expect(await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8")).toContain('"resultRef"');
});

test("reports an interrupted process exit and persists it rather than blaming the JSON protocol", async () => {
  const value = await context();
  await expect(consumeDsh(handle(opening, 137), value, "")).rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
  expect(await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8")).toContain('"exit":{"code":137,"signal":null}');
});

test("keeps a model rejection's specific diagnostic instead of replacing it with exit 1", async () => {
  await expect(consumeDsh(handle([...opening, closing[0],
    { type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { message: "Consumer is forbidden" } } },
    { type: "final", text: "" }], 1), await context(), ""))
    .rejects.toMatchObject({ code: "SOLVER_RESULT_INCOMPLETE", cause: { message: "Consumer is forbidden" } });
});

test("rejects exit zero without final, and rejects nonzero exit even with a completed answer", async () => {
  await expect(consumeDsh(handle([...opening, ...closing]), await context(), ""))
    .rejects.toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
  await expect(consumeDsh(handle([...opening, ...closing, { type: "final", text: "answer" }], 1), await context(), ""))
    .rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
});
