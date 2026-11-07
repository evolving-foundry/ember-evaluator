import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  parseNodeConfig,
  resolvePluginPatchPath,
} from "../../src/infrastructure/ray/node-config.js";
import { localizePortableSelection, projectRemoteJob, validateRemoteJob } from "../../src/infrastructure/ray/protocol.js";
import { openPluginRegistry, type PluginRegistry } from "../../src/application/plugins/open-registry.js";
import { DEFINED_BENCHMARKS } from "../../src/plugins/benchmarks/agent-harness/definitions/index.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { mixedSnapshot } from "../fixtures/results/mixed-run/fixture.js";

const base = {
  nodeExecutable: "bin/node",
  workerEntry: "worker.js",
  configDirectory: "experiment",
  outputRoot: "evidence",
  caFile: "security/ca.pem",
};
let registry: PluginRegistry;
beforeAll(async () => { registry = await openPluginRegistry(); });
afterAll(async () => { await registry?.dispose(); });
const lookup = (role: string, name: string) => registry.ctx.evaluator.configTransport(role, name);

test("Ray carries explicit phase limits independently of its whole-task transport guard", () => {
  const config = resolveConfig("experiment.yaml", { services: { default: { model: "fixture", base_url: "https://model.invalid" } },
    benchmark: { name: "harbor", config: {} }, environment: "local",
    run: { timeoutSeconds: 7200, solveTimeoutSeconds: 9000, verifyTimeoutSeconds: 120 } }, []);
  const remote = projectRemoteJob({ job: { runId: mixedSnapshot.run.runId, taskId: "pass", attemptId: "phase-attempt", ref: { id: "pass", recordKey: "pass" }, configFingerprint: mixedSnapshot.run.configFingerprint },
    run: mixedSnapshot.run, config, packageDigest: `sha256:${"a".repeat(64)}`, uploadEndpoint: "https://collector.invalid", previousAttempts: [], configTransport: lookup });
  expect(remote.safeConfig).toMatchObject({ timeoutSeconds: 7200, solveTimeoutSeconds: 9000, verifyTimeoutSeconds: 120 });
  expect(validateRemoteJob(remote, lookup)).toEqual(remote);
  for (const key of ["solveTimeoutSeconds", "verifyTimeoutSeconds"]) for (const value of [0, -1, "10", null]) {
    expect(() => validateRemoteJob({ ...remote, safeConfig: { ...remote.safeConfig, [key]: value } }, lookup)).toThrow(key);
  }
});

test("Ray node config resolves a preinstalled plugin patch relative to its own file", () => {
  expect(parseNodeConfig({ ...base, pluginPatchPath: "plugins/cordis.patch.yaml" }, "C:/worker/config").pluginPatchPath)
    .toBe(resolve("C:/worker/config", "plugins/cordis.patch.yaml"));
});

test("Ray node config leaves plugin patch loading disabled when no path is configured", () => {
  expect(parseNodeConfig(base, "/worker/config").pluginPatchPath).toBeUndefined();
});

test("Ray Jobs resolves its deployment patch path against the process directory", () => {
  expect(resolvePluginPatchPath("installed/cordis.patch.yaml", "C:/jobs"))
    .toBe(resolve("C:/jobs", "installed/cordis.patch.yaml"));
  expect(resolvePluginPatchPath(undefined, "C:/jobs")).toBeUndefined();
  expect(() => resolvePluginPatchPath("", "C:/jobs")).toThrow(/non-empty string/i);
});

test.each(DEFINED_BENCHMARKS.map(item => item.definition.name))("%s Profile caches are replaced with node-local paths for Ray", name => {
  const selection = { name, config: { cacheDir: resolve("coordinator/cache") } };
  const config = resolveConfig("experiment.yaml", { services: { default: { model: "fixture", base_url: "https://model.invalid" } }, benchmark: selection, environment: "local" }, []);
  const portable = projectRemoteJob({
    job: { runId: mixedSnapshot.run.runId, taskId: "pass", attemptId: "new-attempt", ref: { id: "pass", recordKey: "pass" }, configFingerprint: mixedSnapshot.run.configFingerprint },
    run: mixedSnapshot.run, config, packageDigest: `sha256:${"a".repeat(64)}`, uploadEndpoint: "https://collector.invalid", previousAttempts: [],
    configTransport: lookup,
  }).safeConfig.benchmark;
  expect(portable.config.cacheDir).toBeUndefined();
  expect(localizePortableSelection(portable, "benchmark", { outputRoot: "/node/evidence" }, lookup).config.cacheDir)
    .toBe(join("/node/evidence", "cache", "benchmark", name));
  expect(selection.config.cacheDir).toBe(resolve("coordinator/cache"));
});
