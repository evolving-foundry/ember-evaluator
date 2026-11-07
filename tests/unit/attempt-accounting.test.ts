import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { collectAttemptAccounting } from "../../src/core/results/attempt-accounting.js";
import { storeRecord } from "../fixtures/results/store-fixture.js";
test("failed attempt retains provider usage in a valid trajectory prefix and leaves unobserved cost incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "attempt-accounting-"));
  try {
    await mkdir(join(root, "agent"));
    const record = { ...storeRecord(), executionStatus: "failed" as const, scoreStatus: "invalid" as const, solve: null, verdict: null };
    const event = (seq: number, type: string, data: unknown) => JSON.stringify({ schemaVersion: 1, key: record.key, seq, type, at: new Date().toISOString(), data }) + "\n";
    await writeFile(join(root, "agent/trajectory.jsonl"), event(1, "start", {}) + event(2, "message", { role: "assistant", usage: { input: 10, cacheRead: 2, cacheWrite: 0, output: 20, totalTokens: 32, cost: { total: 0.01 } } }) + event(3, "tool_result", { usage: { totalTokens: 9999 } }) + '{"broken":');
    await collectAttemptAccounting(root, record);
    expect(record.accounting).toEqual({ usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 }, cost: 0.01, currency: "USD", complete: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("missing provider observations remain unknown rather than zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "attempt-unknown-"));
  try {
    const record = { ...storeRecord(), solve: null };
    await collectAttemptAccounting(root, record);
    expect(record.accounting).toMatchObject({ usage: { inputTokens: null, outputTokens: null, totalTokens: null }, cost: null, complete: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([true, false])("cumulative checkpoints include compaction without counting prior calls twice (completed=%s)", async completed => {
  const root = await mkdtemp(join(tmpdir(), "attempt-checkpoint-"));
  try {
    await mkdir(join(root, "agent"));
    const record = { ...storeRecord(), solve: completed ? { finalText: "answer", usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } } : null };
    const event = (seq: number, type: string, data: unknown) => JSON.stringify({ schemaVersion: 1, key: record.key, seq, type, at: new Date().toISOString(), data }) + "\n";
    await writeFile(join(root, "agent/trajectory.jsonl"),
      event(1, "start", {}) +
      event(2, "message", { role: "assistant", usage: { input: 10, cacheRead: 2, cacheWrite: 3, output: 20, totalTokens: 35, cost: { total: 0.01 } } }) +
      // Adds a summary call with 100 input / 30 output to the first call.
      event(3, "usage", { inputTokens: 115, outputTokens: 50, totalTokens: 165, cost: 0.03 }) +
      event(4, "message", { role: "assistant", usage: { input: 5, output: 6, totalTokens: 11, cost: { total: 0.02 } } }) +
      event(5, "usage", { inputTokens: 120, outputTokens: 56, totalTokens: 176, cost: 0.05 }) +
      event(6, "usage", { inputTokens: 120, outputTokens: 56, totalTokens: 176, cost: 0.05 }) +
      // A stale total and an interrupted write must not erase the known prefix.
      event(7, "usage", { inputTokens: 5, outputTokens: null, totalTokens: 11, cost: 0.01 }) + '{"broken":');
    await collectAttemptAccounting(root, record);
    expect(record.accounting).toEqual({ usage: { inputTokens: 120, outputTokens: 56, totalTokens: 176 }, cost: 0.05, currency: "USD", complete: completed });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("completed attempts count the full trajectory instead of only the final active context", async () => {
  const root = await mkdtemp(join(tmpdir(), "attempt-history-"));
  try {
    await mkdir(join(root, "agent"));
    const record = { ...storeRecord(), solve: { finalText: "answer", usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } } };
    const event = (seq: number, type: string, data: unknown) => JSON.stringify({ schemaVersion: 1, key: record.key, seq, type, at: new Date().toISOString(), data }) + "\n";
    await writeFile(join(root, "agent/trajectory.jsonl"), event(1, "start", {}) +
      event(2, "message", { role: "assistant", usage: { input: 10, output: 20, totalTokens: 30 } }) +
      event(3, "message", { role: "assistant", usage: { input: 5, output: 6, totalTokens: 11 } }) +
      event(4, "usage", record.solve.usage));
    await collectAttemptAccounting(root, record);
    expect(record.accounting?.usage).toEqual({ inputTokens: 15, outputTokens: 26, totalTokens: 41 });
    // A solver's aggregate remains useful when it has no message-level evidence.
    await writeFile(join(root, "agent/trajectory.jsonl"), event(1, "start", {}));
    await collectAttemptAccounting(root, record);
    expect(record.accounting?.usage).toEqual(record.solve.usage);
  } finally { await rm(root, { recursive: true, force: true }); }
});
