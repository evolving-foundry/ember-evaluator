import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { inspectLocalDsh, selectLocalDsh } from "../../src/runtimes/dsh/local-runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh selector "))); roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"fixture-dsh","type":"module"}');
  const entry = join(root, "bin.js");
  await writeFile(entry, "console.log('0.1.6-alpha.2');");
  return { root, entry };
}
test("explicit selection wins and a broken override never falls back", async () => {
  const { root, entry } = await fixture();
  expect((await selectLocalDsh({ DSH_BIN: entry, DSH_CHECKOUT: root })).source).toBe("DSH_BIN");
  await expect(selectLocalDsh({ DSH_BIN: join(root, "missing.js"), DSH_CHECKOUT: root })).rejects.toThrow("DSH_BIN");
  await expect(selectLocalDsh({ DSH_BIN: "relative.js" })).rejects.toThrow("absolute");
  await expect(selectLocalDsh({ PATH: "" })).rejects.toThrow("does not install");
});
test("checkout built and tsx entries match the proposer selection contract", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "apps/cli/lib"), { recursive: true });
  await writeFile(join(root, "apps/cli/lib/bin.js"), "");
  expect((await selectLocalDsh({ DSH_CHECKOUT: root })).args).toEqual([join(root, "apps/cli/lib/bin.js")]);
  await rm(join(root, "apps/cli/lib/bin.js"));
  await mkdir(join(root, "apps/cli/src"), { recursive: true });
  await mkdir(join(root, "node_modules/tsx/dist/esm"), { recursive: true });
  await writeFile(join(root, "apps/cli/src/bin.ts"), "");
  await writeFile(join(root, "node_modules/tsx/dist/esm/index.mjs"), "");
  expect((await selectLocalDsh({ DSH_CHECKOUT: root })).args[0]).toBe("--import");
});
test("PATH shim is pinned and can be probed on the native platform", async () => {
  const { root } = await fixture();
  const entry = join(root, process.platform === "win32" ? "dsh.cmd" : "dsh");
  await writeFile(entry, process.platform === "win32" ? "@echo off\r\necho 0.1.6-alpha.2\r\n" : "#!/bin/sh\necho 0.1.6-alpha.2\n", { mode: 0o755 });
  const env = { ...process.env, DSH_BIN: undefined, DSH_CHECKOUT: undefined, PATH: root };
  expect((await inspectLocalDsh(env, AbortSignal.timeout(15_000))).source).toBe("PATH");
}, 20_000);

test("probes the selected version without installing DSH", async () => {
 const {entry}=await fixture();
 expect((await inspectLocalDsh({...process.env, DSH_BIN:entry},AbortSignal.timeout(15000))).version).toBe("0.1.6-alpha.2");
});
