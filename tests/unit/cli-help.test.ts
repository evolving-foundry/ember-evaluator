import { expect, test } from "vitest";
import { parseArgs, runCli } from "../../src/cli/main.js";

test.each([
  ["benchmark list", "--json", "--patch"],
  ["benchmark info", "<name>", "--patch"],
  ["run", "--resume", "--api-key-env", "--dry-run"],
  ["warmup", "--task-ids-file", "--progress"],
  ["retry", "--task-id", "--request-id"],
  ["cleanup images", "--all", "--yes"],
  ["kernel precision", "--seeds", "--device"],
  ["kernel bench", "--problem", "--kernel", "--out"],
  ["kernel profile", "--round", "--python"],
  ["init", "--benchmark", "--output"],
  ["doctor", "--network", "--patch"],
  ["inspect", "--network", "--patch"],
  ["report", "<run-dir>"],
  ["cleanup", "images"],
  ["kernel", "bench", "precision", "profile"],
])("%s help describes its own arguments without executing", async (path, ...flags) => {
  const out: string[] = [], errors: string[] = [];
  expect(await runCli([...path.split(" "), "--help"], { out: text => out.push(text), error: text => errors.push(text) })).toBe(0);
  expect(errors).toEqual([]);
  const help = out.join("\n");
  for (const flag of flags) expect(help).toContain(flag);
  expect(help).toContain("Usage:");
  expect(help).not.toContain("roofline");
});

test.each(["warmup", "doctor", "inspect"])(
  "%s reads model settings from YAML and rejects model overrides",
  async path => {
    const command = path.split(" ");
    const out: string[] = [];
    expect(await runCli([...command, "--help"], { out: text => out.push(text), error: () => {} })).toBe(0);
    for (const flag of ["--model", "--endpoint", "--api-key", "--api-key-env"]) {
      expect(out.join("\n")).not.toContain(flag);
      expect(() => parseArgs([...command, "experiment.yaml", flag, "override"])).toThrow("unknown option");
    }
    expect(parseArgs([...command, "experiment.yaml"])).toMatchObject({ overrides: {} });
  },
);

test("run retains model and credential overrides", () => {
  expect(parseArgs(["run", "experiment.yaml", "--model", "custom", "--endpoint", "https://model.test", "--api-key-env", "MODEL_KEY"]))
    .toMatchObject({ kind: "run", overrides: { model: "custom", endpoint: "https://model.test", apiKeyEnv: "MODEL_KEY" } });
  expect(parseArgs(["run", "experiment.yaml", "--api-key", "fixture-key"]))
    .toMatchObject({ kind: "run", overrides: { apiKey: "fixture-key" } });
});

test.each([["config"], ["config", "resolve", "experiment.yaml"], ["unknown"]])("removed or unknown command %j prints root help", async (...args) => {
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(args, { out: text => out.push(text), error: text => errors.push(text) })).toBe(2);
  expect([...out, ...errors].join("\n")).toContain("Usage: ember-evaluator");
});
test.each(["benchmark", "cleanup", "kernel"])("%s without a subcommand prints its help", async name => {
  const out: string[] = [], errors: string[] = [];
  expect(await runCli([name], { out: text => out.push(text), error: text => errors.push(text) })).toBe(2);
  expect([...out, ...errors].join("\n")).toContain("Usage: ember-evaluator " + name);
});
test("root help includes benchmark and omits config", () => {
  const result = parseArgs(["--help"]);
  expect(result).toMatchObject({ kind: "help" });
  if (result.kind === "help") {
    expect(result.text).toMatch(/^  benchmark\s/m);
    expect(result.text).not.toMatch(/^  config\s/m);
  }
});
