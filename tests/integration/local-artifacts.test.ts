import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { t as listTar } from "tar";
import { afterEach, expect, test } from "vitest";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";

const fixtures: { root: string; session: EnvironmentSession }[] = [];
afterEach(async () => {
  for (const { root, session } of fixtures.splice(0)) {
    await session.dispose(new AbortController().signal);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/local-artifacts-"));
  const initial = join(root, "fixture.txt"); await writeFile(initial, "controlled-evidence");
  const session = await new LocalEnvironment(root).prepare({ workdir: ".", image: null, runtime: [], initialFiles: [
    { source: initial, target: "output/evidence.txt" }, { source: initial, target: "not-selected.txt" },
  ] }, { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") }, "solve", new AbortController().signal);
  fixtures.push({ root, session }); return { root, session, target: join(root, "artifacts", "snapshot.tar") };
}

test("local artifacts snapshot only declared paths, works after quiesce and records the archive digest", async () => {
  const { session, target } = await fixture();
  await session.quiesce?.(new AbortController().signal);
  const artifact = await session.exportState({ kind: "artifacts", workdir: ".", paths: ["output"], optionalPaths: ["absent.txt"] }, target, new AbortController().signal);
  const names: string[] = [];
  await listTar({ file: target, onReadEntry: entry => { names.push(entry.path); } });
  expect(names).toContain("output/evidence.txt");
  expect(names).not.toContain("not-selected.txt");
  expect(artifact.sha256).toBe(createHash("sha256").update(await readFile(target)).digest("hex"));
  await session.dispose(new AbortController().signal);
  expect((await readFile(target)).length).toBeGreaterThan(0);
});

test("local artifacts reject path escapes, missing required files and system state exports", async () => {
  const { session, target } = await fixture();
  for (const path of ["../outside", "../../outside", "/etc/passwd"])
    await expect(session.exportState({ kind: "artifacts", workdir: ".", paths: [path] }, target, new AbortController().signal)).rejects.toThrow();
  await expect(session.exportState({ kind: "artifacts", workdir: ".", paths: ["missing"] }, target, new AbortController().signal)).rejects.toThrow(/missing/);
  await expect(session.exportState({ kind: "workspace-archive", workdir: ".", extraPaths: [] }, target, new AbortController().signal)).rejects.toThrow(/only exports/);
  await expect(readFile(target)).rejects.toThrow();
});

test("local artifacts reject linked output and do not publish after cancellation", async () => {
  const { root, session, target } = await fixture();
  const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "private"), "not-an-artifact");
  await symlink(outside, join(session.workdir, "output", "link"), process.platform === "win32" ? "junction" : "dir");
  await expect(session.exportState({ kind: "artifacts", workdir: ".", paths: ["output"] }, target, new AbortController().signal)).rejects.toThrow(/link/i);
  const controller = new AbortController(); controller.abort();
  await expect(session.exportState({ kind: "artifacts", workdir: ".", paths: ["output"] }, target, controller.signal)).rejects.toThrow();
  await expect(readFile(target)).rejects.toThrow();
});
