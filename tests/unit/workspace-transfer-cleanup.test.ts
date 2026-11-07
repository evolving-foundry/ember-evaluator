import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { afterEach, expect, test } from "vitest";
import type { TransferArtifact, TransferSpec } from "../../src/core/contracts/environment.js";
import { EVALUATOR_NODE_EXECUTABLE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { restoreWorkspace, STATE_HELPER } from "../../src/infrastructure/filesystem/workspace-transfer.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function artifact(): Promise<TransferArtifact> {
  const root = await mkdtemp(join(tmpdir(), "evaluator-transfer-cleanup-"));
  roots.push(root);
  const spec: TransferSpec = { kind: "workspace-archive", workdir: "/workspace", extraPaths: [] };
  await writeFile(join(root, "manifest.json"), JSON.stringify({ version: 1, spec, present: [false], entries: [] }));
  const path = join(root, "state.tar");
  await create({ cwd: root, file: path, portable: true }, ["manifest.json"]);
  return { path, spec, sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
}

test("successful restore removes its staging without launching another Node signal helper", async () => {
  const calls: string[][] = [];
  const command: DockerCommand = async args => { calls.push(args); return { stdout: "", stderr: "" }; };
  await restoreWorkspace({ id: "fixture-container", workdir: "/workspace", command }, await artifact(), new AbortController().signal);
  expect(calls.some(args => args.includes("signal"))).toBe(false);
  const cleanup = calls.at(-1)!;
  expect(cleanup.slice(0, 5)).toEqual(["exec", "fixture-container", EVALUATOR_NODE_EXECUTABLE, STATE_HELPER, "cleanup"]);
  expect(cleanup[5]).toMatch(/^[a-f0-9-]+$/u);
});

test("failed restore still terminates the transfer process and cleans only its token directory", async () => {
  const calls: string[][] = [];
  const failure = new Error("restore failed");
  const command: DockerCommand = async args => {
    calls.push(args);
    if (args.includes(STATE_HELPER) && args.includes("restore")) throw failure;
    return { stdout: "", stderr: "" };
  };
  await expect(restoreWorkspace({ id: "fixture-container", workdir: "/workspace", command }, await artifact(), new AbortController().signal))
    .rejects.toBe(failure);
  const signal = calls.find(args => args.includes("signal"))!;
  expect(signal.at(-1)).toBe("SIGKILL");
  expect(calls.at(-1)!.at(-1)).toBe(signal[5]);
});

test("cleanup errors retain both the failed restore and the specific cleanup operation", async () => {
  const failure = new Error("restore failed");
  const command: DockerCommand = async args => {
    if (args.includes(STATE_HELPER) && args.includes("restore")) throw failure;
    if (args.includes("cleanup")) throw new Error("permission denied");
    return { stdout: "", stderr: "" };
  };
  try {
    await restoreWorkspace({ id: "fixture-container", workdir: "/workspace", command }, await artifact(), new AbortController().signal);
    throw new Error("expected cleanup failure");
  } catch (error) {
    expect(error).toMatchObject({ code: "CLEANUP_FAILED", cause: expect.any(AggregateError) });
    const causes = (error as Error & { cause: AggregateError }).cause.errors;
    expect(causes[0]).toBe(failure);
    expect(causes[1]).toMatchObject({ message: expect.stringContaining("remove workspace transfer staging in fixture-container") });
  }
});
