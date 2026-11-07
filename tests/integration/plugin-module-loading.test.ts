import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadPluginModule } from "../../src/application/plugins/load-module.js";
import { loadPluginPatch } from "../../src/config/plugin-patch.js";

const roots: string[] = [];

async function createProject(): Promise<string> {
  await mkdir(".scratch", { recursive: true });
  const directory = await mkdtemp(resolve(".scratch/plugin-loading-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("reading a patch does not execute its modules; explicit loading uses the patch directory and file digest", async () => {
  const directory = await createProject();
  const patchPath = join(directory, "cordis.patch.yaml");
  const entry = { id: "local-plugin", name: "./plugin with spaces.mjs" };
  const source = [
    'import { writeFile } from "node:fs/promises";',
    'await writeFile(new URL("./imported.txt", import.meta.url), "imported");',
    'export default { marker: "local-plugin" };',
    "",
  ].join("\n");
  const patch = JSON.stringify([{ insert: [entry] }]);
  await writeFile(join(directory, "plugin with spaces.mjs"), source);
  await writeFile(patchPath, patch);

  const loadedPatch = await loadPluginPatch(patchPath);
  expect(loadedPatch).toEqual({
    entries: [entry],
    patchPath,
    patchDigest: `sha256:${createHash("sha256").update(patch).digest("hex")}`,
  });
  await expect(readFile(join(directory, "imported.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  const loadedModule = await loadPluginModule(entry, patchPath);
  expect(loadedModule).toEqual({
    id: entry.id,
    plugin: { marker: "local-plugin" },
    version: `sha256:${createHash("sha256").update(source).digest("hex")}`,
  });
  expect(await readFile(join(directory, "imported.txt"), "utf8")).toBe("imported");
});

test("package loading resolves the patch project's dependency and preserves its package version", async () => {
  const directory = await createProject();
  const packageRoot = join(directory, "node_modules", "fixture-patch-plugin");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture-patch-plugin",
    version: "1.2.3",
    type: "module",
    exports: "./index.js",
  }));
  await writeFile(join(packageRoot, "index.js"), 'export const marker = "patch-project-plugin";\n');

  const loaded = await loadPluginModule(
    { id: "package-plugin", name: "fixture-patch-plugin" },
    join(directory, "cordis.patch.yaml"),
  );
  expect(loaded).toMatchObject({
    id: "package-plugin",
    version: "1.2.3",
    plugin: { marker: "patch-project-plugin" },
  });
});

test.each(["path", "package"])("rejects a TypeScript %s entry before executing it", async kind => {
  const directory = await createProject();
  const packageRoot = join(directory, "node_modules", "fixture-typescript-plugin");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "fixture-typescript-plugin",
    version: "1.0.0",
    exports: "./index.ts",
  }));
  await writeFile(join(packageRoot, "index.ts"), 'throw new Error("TypeScript plugin executed");\n');
  const name = kind === "path" ? "./node_modules/fixture-typescript-plugin/index.ts" : "fixture-typescript-plugin";

  await expect(loadPluginModule({ id: "typescript-plugin", name }, join(directory, "cordis.patch.yaml")))
    .rejects.toThrow(kind === "path" ? "must be compiled to JavaScript" : "resolved to uncompiled TypeScript");
});
