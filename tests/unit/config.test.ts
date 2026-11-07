import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { stringify } from "yaml";
import { loadConfig, loadSavedConfig } from "../../src/application/config.js";
import { exportConfig } from "../../src/config/export.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const services = { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${KEY}" } };
async function file(value: unknown, filename = "experiment.yaml") {
  const root = await mkdtemp(join(tmpdir(), "config-")); roots.push(root);
  const path = join(root, filename); await writeFile(path, stringify(value)); return path;
}
const load = (path: string) => loadConfig(path, {}, { KEY: "secret" });

test.each([undefined, { name: "local" }, { name: "local", config: {} }])("local execution and preparation default to one with scheduler %j", async scheduler => {
  const loaded = await load(await file({ services, benchmark: "gsm8k", ...(scheduler ? { scheduler } : {}),
    run: { preparation: {} } }));
  expect(loaded.experiment.scheduler).toEqual({ name: "local", config: { concurrency: 1 } });
  expect(loaded.experiment.run.preparation).toMatchObject({ concurrency: 1 });
  expect(loaded.persisted).toHaveProperty("scheduler.config.concurrency", 1);
});

test("explicit execution/preparation limits and saved serial configurations retain their values", async () => {
  const loaded = await load(await file({ services, benchmark: "gsm8k", scheduler: { concurrency: 3 },
    run: { preparation: { concurrency: 2 } } }));
  expect(loaded.experiment.scheduler.config.concurrency).toBe(3);
  expect(loaded.experiment.run.preparation?.concurrency).toBe(2);
  const serial = await load(await file({ services, benchmark: "gsm8k", scheduler: { concurrency: 1 } }));
  const saved = await loadSavedConfig(await file(serial.persisted, "saved.yaml"), { KEY: "secret" });
  expect(saved.experiment.scheduler.config.concurrency).toBe(1);
});

test("whole-task default is two hours and omitted phase overrides remain absent", async () => {
  const loaded = await load(await file({ services, benchmark: "gsm8k" }));
  expect(loaded.experiment.run.timeoutSeconds).toBe(7200);
  expect(loaded.experiment.run).not.toHaveProperty("solveTimeoutSeconds");
  expect(loaded.experiment.run).not.toHaveProperty("verifyTimeoutSeconds");
  expect(loaded.persisted).not.toHaveProperty("run.solveTimeoutSeconds");
  expect(loaded.persisted).not.toHaveProperty("run.verifyTimeoutSeconds");
});

test("whole-task and the two phase ceilings are independently configured and saved", async () => {
  const run = { timeoutSeconds: 100, solveTimeoutSeconds: 200, verifyTimeoutSeconds: 30 };
  const loaded = await load(await file({ services, benchmark: "gsm8k", run }));
  expect(loaded.experiment.run).toMatchObject(run);
  expect(loaded.persisted).toHaveProperty("run.solveTimeoutSeconds", 200);
  expect(loaded.persisted).toHaveProperty("run.verifyTimeoutSeconds", 30);
});

test("preparation base and optional round limit survive saving without injecting an omitted round limit", async () => {
  const preparation = { mode: "pipeline", concurrency: 32, environmentTimeoutSeconds: 600, roundTimeoutSeconds: 7200 };
  const loaded = await load(await file({ services, benchmark: "gsm8k", run: { preparation } }));
  expect(loaded.experiment.run.preparation).toEqual(preparation);
  expect(loaded.persisted).toHaveProperty("run.preparation", preparation);
  const saved = await loadSavedConfig(await file(loaded.persisted, "saved.yaml"), { KEY: "secret" });
  expect(saved.experiment.run.preparation).toEqual(preparation);
  const omitted = await load(await file({ services, benchmark: "gsm8k", run: { preparation: { concurrency: 2 } } }));
  expect(omitted.experiment.run.preparation).not.toHaveProperty("roundTimeoutSeconds");
});

test.each(["environmentTimeoutSeconds", "roundTimeoutSeconds"])("invalid preparation %s is rejected", async key => {
  for (const value of [0, -1, null, "600", Number.POSITIVE_INFINITY, 2147484])
    await expect(load(await file({ services, benchmark: "gsm8k", run: { preparation: { [key]: value } } }))).rejects.toThrow();
});

test.each(["solveTimeoutSeconds", "verifyTimeoutSeconds"])("phase ceiling %s rejects zero, negative and nonnumeric input", async field => {
  for (const value of [0, -1, "10", null, 1.5]) {
    await expect(load(await file({ services, benchmark: "gsm8k", run: { [field]: value } }))).rejects.toThrow(`run.${field}`);
  }
});

test.each([
  ["gsm8k", "gsm8k-agentbundle.yaml", "gsm8k", "gsm8k-agentbundle"],
  ["deepswe", "experiment.v2.yml", "deepswe", "experiment.v2"],
  [{ name: "workbuddy", scenario: "office" }, "Office 评测.YAML", "workbuddy", "Office 评测"],
] as const)("default output groups %j and %s beneath the repository results directory", async (benchmark, filename, name, stem) => {
  const path = await file({ services, benchmark }, filename);
  const loaded = await load(path);
  const expected = join(import.meta.dirname, "../..", "results", name, stem);
  expect(loaded.experiment.output.directory).toBe(expected);
  expect(loaded.persisted).toHaveProperty("output.directory", expected);
  expect(loaded.resolution?.origins["output.directory"]).toBe("generated");
});

test("empty output uses the filename default, and exported or saved configs retain that directory", async () => {
  const loaded = await load(await file({ services, benchmark: "gsm8k", output: {} }, "original.yml"));
  const expected = join(import.meta.dirname, "../..", "results", "gsm8k", "original");
  expect(loaded.experiment.output.directory).toBe(expected);
  const exported = await load(await file(exportConfig(loaded), "renamed-export.yaml"));
  expect(exported.experiment.output.directory).toBe(expected);
  const saved = await loadSavedConfig(await file(loaded.persisted, "saved-config.yaml"), { KEY: "secret" });
  expect(saved.experiment.output.directory).toBe(expected);
});

test.each([
  [{ mode: "pipeline", concurrency: 4, lookahead: 10 }, true],
  [{ mode: "pipeline", concurrency: 4, lookahead: 3 }, false],
  [{ mode: "pipeline", concurrency: 0 }, false],
  [{ mode: "pipeline", lookahead: -1 }, false],
  [{ mode: "batch", concurrency: 2 }, true],
  [{ mode: "batch", concurrency: 0 }, false],
  [{ mode: "batch", concurrency: 1.5 }, false],
  [{ mode: "batch", concurrency: "2" }, false],
  [{ mode: "batch", lookahead: 10 }, false],
  [{ mode: "unknown" }, false],
  [{ mode: "pipeline", typo: 2 }, false],
])("validates preparation %j", async (preparation, valid) => {
  const path = await file({ services, benchmark: "gsm8k", run: { preparation } });
  if (!valid) await expect(load(path)).rejects.toThrow(/run.preparation/);
  else expect((await load(path)).experiment.run.preparation).toEqual(preparation);
});

test.each([{}, { mode: "batch" }, { mode: "pipeline" }, { concurrency: 2 }, { lookahead: 4 }])("defaults local preparation fields for %j", async preparation => {
  const loaded = await load(await file({ services, benchmark: "gsm8k", scheduler: { concurrency: 4 }, run: { preparation } }));
  expect(loaded.experiment.run.preparation).toEqual({ mode: "pipeline", concurrency: 4, ...preparation });
  expect(loaded.persisted).toHaveProperty("run.preparation", { mode: "pipeline", concurrency: 4, ...preparation });
});

test("lookahead is validated against execution concurrency when preparation concurrency is omitted", async () => {
  await expect(load(await file({ services, benchmark: "gsm8k", scheduler: { concurrency: 4 },
    run: { preparation: { lookahead: 3 } } }))).rejects.toThrow(/run.preparation.lookahead/);
  const loaded = await load(await file({ services, benchmark: "gsm8k", scheduler: { concurrency: 4 },
    run: { preparation: { concurrency: 2, lookahead: 3 } } }));
  expect(loaded.experiment.run.preparation).toEqual({ mode: "pipeline", concurrency: 2, lookahead: 3 });
});

test("Ray partial preparation retains batch mode and inherits execution concurrency", async () => {
  const loaded = await load(await file({ services, benchmark: "gsm8k", scheduler: { name: "ray", concurrency: 4 }, run: { preparation: {} } }));
  expect(loaded.experiment.run.preparation).toEqual({ mode: "batch", concurrency: 4 });
  await expect(load(await file({ services, benchmark: "gsm8k", scheduler: { name: "ray", concurrency: 4 },
    run: { preparation: { lookahead: 4 } } }))).rejects.toThrow(/run.preparation.lookahead/);
});

test("omitted preparation keeps the historical configuration fingerprint inputs unchanged", async () => {
  const loaded = await load(await file({ services, benchmark: "gsm8k" }));
  expect(loaded.experiment.run.preparation).toBeUndefined();
  expect(loaded.persisted).not.toHaveProperty("run.preparation");
});

test("rejects removed whole-task retry configuration", async () => {
  await expect(load(await file({ services, benchmark: "gsm8k", run: { taskRetry: { maxAttempts: 1 } } })))
    .rejects.toThrow(/taskRetry/);
});

test.each([{ benchmarks: [] }, { model: {} }, { solver: {} }])("rejects legacy root fields %j", async legacy => {
  await expect(load(await file({ services, benchmark: "gsm8k", ...legacy }))).rejects.toThrow(/unknown field/);
});

test("exports current YAML and explicitly reads saved execution configuration", async () => {
  const loaded = await load(await file({ services, benchmark: "gsm8k", environment: "local" }));
  expect((await load(await file(exportConfig(loaded)))).experiment).toEqual(loaded.experiment);
  const saved = await file(loaded.persisted);
  await expect(load(saved)).rejects.toThrow(/unknown field/);
  expect((await loadSavedConfig(saved, { KEY: "secret" })).experiment).toEqual(loaded.experiment);
});

test("sensitive plugin references survive nested config persistence but expanded values do not", async () => {
  const path = await file({ services, benchmark: { name: "unregistered", config: {
    accessToken: "${DATA_TOKEN}", nested: [{ secret: "${NESTED_SECRET}" }], literalSecret: "literal-sensitive-value",
  } } });
  const loaded = await loadConfig(path, {}, { KEY: "model-secret", DATA_TOKEN: "dataset-secret", NESTED_SECRET: "nested-value" }, { validatePlugins: false });
  expect(loaded.persisted).toMatchObject({ benchmark: { config: { accessToken: "${DATA_TOKEN}", nested: [{ secret: "${NESTED_SECRET}" }], literalSecret: "[redacted]" } } });
  for (const secret of ["dataset-secret", "nested-value", "literal-sensitive-value"]) expect(JSON.stringify(loaded.persisted)).not.toContain(secret);
});


test("resolves only referenced credentials and preserves unused references", async () => {
  const loaded = await load(await file({ services: { ...services,
    unused: { model: "other", base_url: "https://unused.invalid", api_key: "${UNSET_KEY}" } }, benchmark: "gsm8k" }));
  expect(loaded.auths.default).toEqual({ value: "secret", reference: "KEY" });
  expect(loaded.auths.unused).toBeUndefined();
  expect(JSON.stringify(loaded.persisted)).toContain("${UNSET_KEY}");
});

test("requires explicit routes with multiple non-default services", async () => {
  await expect(load(await file({ services: { a: services.default, b: services.default }, benchmark: "gsm8k" })))
    .rejects.toThrow(/No default service/);
  await expect(load(await file({ services, benchmark: { name: "gsm8k", solver: { service: "missing" } } })))
    .rejects.toThrow(/unknown service missing/);
});

test("expands judgeService before selecting its required credential", async () => {
  const path = await file({ services: { ...services, grader: { ...services.default, api_key: "${JUDGE_KEY}" } },
    benchmark: { name: "healthbench", config: { judgeService: "${JUDGE_ROUTE}" } } });
  const loaded = await loadConfig(path, {}, { KEY: "solver-secret", JUDGE_KEY: "grader-secret", JUDGE_ROUTE: "grader" });
  expect(loaded.experiment.benchmark.config.judgeService).toBe("grader");
  expect(loaded.auths.grader?.value).toBe("grader-secret");
  expect(JSON.stringify(loaded.persisted)).not.toContain("grader-secret");
  await expect(loadConfig(path, {}, { KEY: "solver-secret", JUDGE_ROUTE: "grader" })).rejects.toThrow(/JUDGE_KEY/);
});

test("rejects inline YAML credentials and CLI authentication conflicts", async () => {
  await expect(load(await file({ services: { default: { ...services.default, api_key: "plaintext" } }, benchmark: "gsm8k" })))
    .rejects.toThrow(/api_key must reference/);
  const path = await file({ services, benchmark: "gsm8k" });
  await expect(loadConfig(path, { apiKey: "inline-test-secret", apiKeyEnv: "OTHER" }, {})).rejects.toThrow(/cannot be used together/);
  const loaded = await loadConfig(path, { apiKey: "inline-test-secret" }, {});
  expect(JSON.stringify(loaded.persisted)).not.toContain('"inline-test-secret"');
  expect(loaded.auths.default?.value).toBe("inline-test-secret");
  const exported = await file(exportConfig(loaded));
  expect((await loadConfig(exported, {}, { EVALUATOR_API_KEY: "replacement" })).auths.default?.value).toBe("replacement");
});

test.each([0, -1, 1.5, null, "32768"])("rejects invalid model token budget %j", async maxTokens => {
  await expect(load(await file({ services: { default: { ...services.default, maxTokens } }, benchmark: "gsm8k" })))
    .rejects.toThrow(/maxTokens.*positive integer/);
});

test.each([0, -1, 1.5, "4"])("rejects invalid model retries %j", async maxAttempts => {
  await expect(load(await file({ services: { default: { ...services.default, retry: { maxAttempts } } }, benchmark: "gsm8k" })))
    .rejects.toThrow(/retry.maxAttempts.*positive integer/);
});

test.each([undefined, false, true])("includeTaskAnswer: %j", async includeTaskAnswer => {
  const loaded = await load(await file({ services, benchmark: "gsm8k", run: { includeTaskAnswer } }));
  expect(loaded.experiment.run.includeTaskAnswer).toBe(includeTaskAnswer === true ? true : undefined);
});
