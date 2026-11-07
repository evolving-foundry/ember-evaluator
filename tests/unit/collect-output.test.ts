import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readCollectOutput } from "../../src/core/artifacts/collect-output.js";
import type { ProcessHandle } from "../../src/core/contracts/environment.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(stderr: string[], stdout: string[], code: number) {
  const root = await mkdtemp(join(tmpdir(), "collect-output-")); roots.push(root);
  const stream = async function* (chunks: string[]) { for (const chunk of chunks) yield Buffer.from(chunk); };
  const handle: ProcessHandle = { stdout: stream(stdout), stderr: stream(stderr), done: Promise.resolve({ code, signal: null }), stop: vi.fn(async () => {}) };
  return { root, handle };
}
test("failed collect commands retain redacted stdout and stderr across chunk boundaries", async () => {
  const { root, handle } = await fixture(["bash: not found; fixture-", "key\n"], ["capture started\n"], 127);
  const result = await readCollectOutput(handle, root, new AbortController().signal, ["fixture-key"]);
  expect(result).toMatchObject({ code: 127, stderr: "bash: not found; [redacted]\n" });
  expect(await readFile(join(root, "stderr.log"), "utf8")).toBe(result.stderr);
  expect(await readFile(join(root, "stdout.log"), "utf8")).toBe("capture started\n");
  expect(handle.stop).toHaveBeenCalledOnce();
});
test("verbose successful hooks drain completely and truncate only their saved diagnostics", async () => {
  const { root, handle } = await fixture([], ["first line\n", "x".repeat(1024 * 1024), "last line"], 0);
  const result = await readCollectOutput(handle, root, new AbortController().signal);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("first line\n\n[output truncated]\n");
});
