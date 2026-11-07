import { expect, test } from "vitest";
import { runCli } from "../../src/cli/main.js";

test("benchmark list displays versions, defaults and scenarios as a table", async () => {
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(["benchmark", "list"], { out: text => out.push(text), error: text => errors.push(text) })).toBe(0);
  expect(errors).toEqual([]);
  expect(out.join("\n")).toContain("Benchmark");
  expect(out.join("\n")).toMatch(/terminalbench\s+2\.0, 4\.0 \(4\.0\.0\)\s+2\.0/);
  expect(out.join("\n")).toMatch(/workbuddy.*code/);
});

test("benchmark list JSON retains version aliases and matches info", async () => {
  const out: string[] = [], errors: string[] = [];
  const io = { out: (text: string) => out.push(text), error: (text: string) => errors.push(text) };
  expect(await runCli(["benchmark", "list", "--json"], io)).toBe(0);
  const rows = JSON.parse(out[0] ?? "");
  const terminalbench = rows.find((row: { name: string }) => row.name === "terminalbench");
  expect(terminalbench).toMatchObject({ versions: ["2.0", "4.0", "4.0.0"], defaultVersion: "2.0", versionGroups: [{ version: "2.0", aliases: [] }, { version: "4.0", aliases: ["4.0.0"] }] });
  expect(rows.find((row: { name: string }) => row.name === "harbor")).toMatchObject({ versions: [], defaultVersion: null });
  expect(await runCli(["benchmark", "info", "terminalbench"], io)).toBe(0);
  const info = JSON.parse(out.at(-1) ?? "");
  expect(info.versions).toEqual(terminalbench.versions);
  expect(info.versionDetails["4.0"].benchmark.config.dataset).toBe("terminal-bench@4.0.0");
  expect(errors).toEqual([]);
});

test("inherited version differences are not collapsed into aliases", async () => {
  const { openPluginRegistry } = await import("../../src/application/plugins/open-registry.js");
  const { benchmarkList } = await import("../../src/application/benchmarks.js");
  const registry = await openPluginRegistry();
  try {
    registry.ctx.evaluator.registerProfile({ id: "alias-parent", role: "benchmark", extends: "harbor", defaultVersion: "1.0", versions: {
      "1.0": { plugin: { name: "harbor", config: { dataset: "first@1.0" } } },
      "2.0": { plugin: { name: "harbor", config: { dataset: "second@1.0" } } },
    } });
    registry.ctx.evaluator.registerProfile({ id: "alias-child", role: "benchmark", extends: "alias-parent", versions: { "1.0": {}, "2.0": {} } });
    expect(benchmarkList(registry).find(row => row.name === "alias-child")?.versionGroups).toEqual([
      { version: "1.0", aliases: [] }, { version: "2.0", aliases: [] },
    ]);
  } finally { await registry.dispose(); }
});
