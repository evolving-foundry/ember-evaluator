import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { inspectDependencies } from "../../scripts/check-dependencies.mjs";

test("dependency checks cover types, exports, dynamic imports, require, package-root bypass and cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-dependencies-"));
  try {
    const sources = {
      "core/types.ts": 'import type { Value } from "../plugins/value.js"; export type Copy = Value;',
      "core/exports.ts": 'export { value } from "../plugins/value.js";',
      "core/dynamic.ts": 'export const load = () => import("../plugins/value.js");',
      "core/require.ts": 'const value = require("../plugins/value.js");',
      "core/root.ts": 'import type { Value } from "ember-evaluator";',
      "core/first.ts": 'import "./second.js";',
      "core/second.ts": 'import "./first.js";',
      "plugins/value.ts": 'export type Value = string; export const value = "value";',
      "infrastructure/loader.ts": 'import "../config/load.js";',
      "infrastructure/pure.ts": 'import "../config/jobs.js";',
      "config/load.ts": 'export {};',
      "config/jobs.ts": 'export {};',
    };
    for (const [file, contents] of Object.entries(sources)) {
      await mkdir(join(root, "src", file, ".."), { recursive: true });
      await writeFile(join(root, "src", file), contents);
    }
    expect(inspectDependencies(root)).toEqual([
      "boundary:core/dynamic.ts -> plugins/value.ts",
      "boundary:core/exports.ts -> plugins/value.ts",
      "boundary:core/require.ts -> plugins/value.ts",
      "boundary:core/root.ts -> ember-evaluator",
      "boundary:core/types.ts -> plugins/value.ts",
      "boundary:infrastructure/loader.ts -> config/load.ts",
      "cycle:core/first.ts -> core/second.ts",
      "cycle:core/second.ts -> core/first.ts",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the repository has no dependency exemptions or forbidden edges", () => {
  expect(inspectDependencies()).toEqual([]);
});
