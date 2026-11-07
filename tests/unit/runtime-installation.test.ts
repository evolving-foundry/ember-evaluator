import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RuntimeInstallation } from "../../src/core/contracts/environment.js";
import { applicationCacheRoot, prepareLocalRuntime, runtimeCacheRoot, runtimeInventory } from "../../src/infrastructure/runtime-installation/install.js";

const roots: string[] = [];
const signal = () => AbortSignal.timeout(20_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  await mkdir(resolve(".scratch"), { recursive: true });
  const root = await mkdtemp(resolve(".scratch/rt-"));
  roots.push(root);
  const source = join(root, "asset.txt");
  await writeFile(source, "first");
  const installation: RuntimeInstallation = {
    id: "fixture-v1", cacheName: "fixture-1.0", files: [{ source, target: "asset.txt" }],
    commands: [{ executable: "node", args: ["-e", "require('node:fs').writeFileSync('installed-at.txt',process.cwd())"] }],
    probes: [{ executable: "node", args: ["-e", "if(require('node:fs').readFileSync('installed-at.txt','utf8')!==process.cwd())process.exit(1)"] }],
  };
  return { root, cache: join(root, "cache"), source, installation };
}

async function identity(installation: RuntimeInstallation) {
  return (await runtimeInventory(installation, `${process.platform}/${process.arch}/node-${process.versions.node}`, signal())).identity;
}

describe("named local runtime installation", () => {
  test("a readable cache name does not change the full content identity", async () => {
    const { installation } = await fixture();
    const first = await identity(installation);
    installation.cacheName = "another-name";
    expect(await identity(installation)).toBe(first);
  });

  test("installs at the final path, reuses identical content and keeps changed content alongside it", async () => {
    const { cache, source, installation } = await fixture();
    const first = await prepareLocalRuntime(installation, cache, signal());
    expect(first.root).toBe(join(await realpath(cache), "fixture-1.0", first.identity.slice(0, 12)));
    expect(await readFile(join(first.root, ".runtime-ready.json"), "utf8")).toBe(first.identity);
    expect(await readFile(join(first.root, "installed-at.txt"), "utf8")).toBe(first.root);
    await writeFile(join(first.root, "reused.txt"), "keep");
    expect(await prepareLocalRuntime(installation, cache, signal())).toEqual(first);
    expect(await readFile(join(first.root, "reused.txt"), "utf8")).toBe("keep");
    await writeFile(source, "second");
    const second = await prepareLocalRuntime(installation, cache, signal());
    expect(second.root).not.toBe(first.root);
    expect(await readFile(join(first.root, "asset.txt"), "utf8")).toBe("first");
    expect(await readFile(join(second.root, "asset.txt"), "utf8")).toBe("second");
    expect(await readdir(join(cache, "fixture-1.0"))).toEqual(expect.arrayContaining([
      first.identity.slice(0, 12), second.identity.slice(0, 12),
    ]));
  }, 30_000);

  test("serializes concurrent preparation and installs only once", async () => {
    const { root, cache, installation } = await fixture();
    const counter = join(root, "count.txt");
    installation.commands.push({ executable: "node", args: ["-e", "require('node:fs').appendFileSync(process.argv[1],'x');setTimeout(()=>{},150)", counter] });
    const locations = await Promise.all(Array.from({ length: 3 }, () => prepareLocalRuntime(installation, cache, signal())));
    expect(locations[1]).toEqual(locations[0]);
    expect(locations[2]).toEqual(locations[0]);
    expect(await readFile(counter, "utf8")).toBe("x");
  }, 30_000);

  test("removes a new failed installation and releases its lock", async () => {
    const { cache, installation } = await fixture();
    installation.probes = [{ executable: "node", args: ["-e", "process.exit(7)"] }];
    await expect(prepareLocalRuntime(installation, cache, signal())).rejects.toThrow("exited 7");
    expect(await readdir(join(cache, "fixture-1.0"))).toEqual([]);
    installation.probes = [];
    await expect(prepareLocalRuntime(installation, cache, signal())).resolves.toMatchObject({ persistent: true });
  }, 30_000);

  test("removes a new cancelled installation after stopping its process", async () => {
    const { root, cache, installation } = await fixture();
    const started = join(root, "started.txt");
    installation.commands = [{ executable: "node", args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'started');setInterval(()=>{},1000)", started] }];
    installation.probes = [];
    const controller = new AbortController();
    const pending = expect(prepareLocalRuntime(installation, cache, controller.signal)).rejects.toThrow("cancel install");
    try {
      await vi.waitFor(async () => expect(await readFile(started, "utf8")).toBe("started"), { timeout: 15_000 });
    } finally {
      controller.abort(new Error("cancel install"));
      await pending;
    }
    expect(await readdir(join(cache, "fixture-1.0"))).toEqual([]);
  }, 30_000);

  test.each(["incomplete", "different digest"])("preserves an existing runtime with %s", async kind => {
    const { cache, installation } = await fixture();
    const full = await identity(installation);
    const root = join(cache, "fixture-1.0", full.slice(0, 12));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "keep.txt"), "keep");
    if (kind === "different digest")
      await writeFile(join(root, ".runtime-ready.json"), `${full.slice(0, 12)}${"f".repeat(52)}`);
    await expect(prepareLocalRuntime(installation, cache, signal())).rejects.toThrow("incomplete or its content identity differs");
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("keep");
  });

  test.each(["../escape", "a/b", "a\\b", "a:b", "CON", "con.txt", "nul", "lpt1", "trailing.", "Uppercase", "", "a".repeat(49)])("rejects unsafe cache name %j", async cacheName => {
    const { cache, installation } = await fixture();
    installation.cacheName = cacheName;
    await expect(prepareLocalRuntime(installation, cache, signal())).rejects.toThrow("cacheName must be a safe");
  });

  test.each(["name", "root", "marker", "state"])("rejects a junction/symlink at the runtime %s without deleting its target", async part => {
    const { root: fixtureRoot, cache, installation } = await fixture();
    installation.commands = [];
    installation.probes = [];
    const full = await identity(installation);
    const named = join(cache, "fixture-1.0");
    const root = join(named, full.slice(0, 12));
    const target = join(fixtureRoot, "target");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "keep");
    const link = part === "name" ? named : part === "root" ? root : part === "marker"
      ? join(root, ".runtime-ready.json") : `${root}.state`;
    await mkdir(part === "name" ? cache : part === "root" ? named : root, { recursive: true });
    if (part === "state") await writeFile(join(root, ".runtime-ready.json"), full);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await expect(prepareLocalRuntime(installation, cache, signal())).rejects.toThrow(/link|junction/u);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep");
  });

  test("keeps unnamed external recipes usable with a short generic parent", async () => {
    const { cache, installation } = await fixture();
    delete installation.cacheName;
    installation.commands = [];
    installation.probes = [];
    const location = await prepareLocalRuntime(installation, cache, signal());
    expect(location.root).toBe(join(await realpath(cache), "runtime", location.identity.slice(0, 12)));
  });
});

test("Windows uses a shorter runtime cache without moving the application cache", () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.stubEnv("LOCALAPPDATA", resolve(".scratch/user-cache"));
  vi.stubEnv("EVALUATOR_RUNTIME_CACHE_DIR", undefined);
  expect(runtimeCacheRoot()).toBe(resolve(".scratch/user-cache/ember/r"));
  expect(applicationCacheRoot()).toBe(resolve(".scratch/user-cache/ember-evaluator"));
});

test("a dedicated runtime cache override must be absolute and does not move application caches", () => {
  const original = applicationCacheRoot();
  vi.stubEnv("EVALUATOR_RUNTIME_CACHE_DIR", resolve(".scratch/short-cache"));
  expect(runtimeCacheRoot()).toBe(resolve(".scratch/short-cache"));
  expect(applicationCacheRoot()).toBe(original);
  vi.stubEnv("EVALUATOR_RUNTIME_CACHE_DIR", "relative/cache");
  expect(() => runtimeCacheRoot()).toThrow("must be an absolute path");
});
