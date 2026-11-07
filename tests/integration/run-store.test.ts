import { fixtureFailure } from "../fixtures/results/store-fixture.js";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, access, symlink, rename } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import { buildFileManifest } from "../../src/core/artifacts/artifacts.js";
import { storeRun, storeKey, storeRecord, trajectoryLines } from "../fixtures/results/store-fixture.js";
import { loadConfig as readConfig } from "../../src/application/config.js";
// These tests exercise assembly validation separately from structural configuration loading.
const loadConfig = (path: string, overrides: Parameters<typeof readConfig>[1], env: Parameters<typeof readConfig>[2]) =>
  readConfig(path, overrides, env, { validatePlugins: false });
import { bootstrap } from "../../src/application/plugins/bootstrap.js";
import { saveReport } from "../../src/application/report/index.js";
import { MarkdownReporter } from "../../src/plugins/reporters/markdown.js";

const roots: string[] = []; const stores: LocalRunStore[] = [];
function instance() { const store = new LocalRunStore(); stores.push(store); return store; }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "evaluator-store-")); roots.push(root);
  const store = instance(); await store.create(root, structuredClone(storeRun), { model: { name: "fixture" } });
  return { root, runDir: join(root, storeRun.runId), store };
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("uncommitted attempts do not score, committed results survive reopen", async () => {
  const { store, runDir } = await setup(); const paths = await store.allocate(storeKey);
  await writeFile(join(paths.agent, "stderr.log"), "persisted");
  expect((await store.snapshot()).pendingTaskIds).toEqual(storeRun.taskIds);
  expect((await store.listAttempts())[0]).toMatchObject({ key: storeKey, ordinal: 1, record: null });
  await store.commit(storeRecord(), await buildFileManifest(paths.root, []));
  await store.close(); const reopened = instance(); await reopened.open(runDir);
  const snapshot = await reopened.snapshot();
  expect(snapshot.records).toEqual([storeRecord()]); expect(snapshot.pendingTaskIds).toEqual(["b"]);
  expect(await readFile(join(paths.agent, "stderr.log"), "utf8")).toBe("persisted");
});

test.each([
  {},
  { source: "", revision: "fixed", files: [], metadata: {} },
  { source: "fixture", revision: "", files: [], metadata: {} },
  { source: "fixture", revision: "opaque-revision", files: {}, metadata: {} },
  { source: "fixture", revision: "opaque-revision", files: [{ path: "data", origin: "", sha256: "a".repeat(64) }], metadata: {} },
  { source: "fixture", revision: "opaque-revision", files: [{ path: "data", origin: "https://fixture.invalid/data", sha256: "not-a-sha256" }], metadata: {} },
  { source: "fixture", revision: "opaque-revision", files: [], metadata: { invalid: undefined } },
])("create rejects a structurally invalid source lock before publishing a run (%#)", async source => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-store-invalid-source-")); roots.push(root);
  const store = instance();
  await expect(store.create(root, { ...storeRun, source } as typeof storeRun, {}))
    .rejects.toMatchObject({ code: "STORE_RECORD_INVALID" });
  await expect(access(join(root, storeRun.runId, "manifest.json"))).rejects.toThrow();
});

test("open rejects a source lock corrupted after a valid run was closed", async () => {
  const { store, runDir } = await setup(); await store.close();
  await writeFile(join(runDir, "manifest.json"), JSON.stringify({ ...storeRun, source: {} }));
  await expect(instance().open(runDir)).rejects.toMatchObject({ code: "STORE_RECORD_INVALID" });
});

test("run manifests preserve absolute plugin patch provenance and reject relative paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-store-patch-path-")); roots.push(root);
  const manifest = {
    ...structuredClone(storeRun),
    pluginRuntime: {
      configDirectory: root,
      patchPath: join(root, "plugins", "cordis.patch.yaml"),
      entries: [],
    },
  };
  const store = instance();
  await store.create(root, manifest, {});
  await store.close();
  const reopened = instance();
  expect(await reopened.open(join(root, storeRun.runId))).toMatchObject({
    pluginRuntime: { patchPath: manifest.pluginRuntime.patchPath },
  });
  await reopened.close();

  const invalidRoot = await mkdtemp(join(tmpdir(), "evaluator-store-patch-path-invalid-")); roots.push(invalidRoot);
  await expect(instance().create(invalidRoot, {
    ...structuredClone(storeRun),
    pluginRuntime: { configDirectory: invalidRoot, patchPath: "plugins/cordis.patch.yaml", entries: [] },
  }, {})).rejects.toMatchObject({ code: "STORE_RECORD_INVALID" });
});

test("one live writer owns the run and close does not release another writer's lock", async () => {
  const { store, runDir } = await setup(); const competitor = instance();
  await expect(competitor.open(runDir)).rejects.toThrow(/lock|writer/i);
  await competitor.close(); await expect(instance().open(runDir)).rejects.toThrow(/lock|writer/i);
  await store.close(); await expect(instance().open(runDir)).resolves.toMatchObject({ runId: "run-1" });
});

test("attempt allocation rejects reuse and traversal without overwriting evidence", async () => {
  const { store } = await setup(); const first = await store.allocate(storeKey);
  await writeFile(join(first.agent, "keep"), "original");
  await expect(store.allocate(storeKey)).rejects.toThrow();
  await expect(store.allocate({ ...storeKey, attemptId: "../../escape" })).rejects.toThrow();
  await expect(store.allocate({ ...storeKey, runId: "different" })).rejects.toThrow();
  expect(await readFile(join(first.agent, "keep"), "utf8")).toBe("original");
});

test("concurrent allocation gives independent paths and monotonic ordinals", async () => {
  const { store } = await setup();
  const paths = await Promise.all(["a1", "a2"].map(attemptId => store.allocate({ ...storeKey, attemptId })));
  expect(paths[0]?.root).not.toBe(paths[1]?.root);
  expect((await store.listAttempts()).map(attempt => attempt.ordinal)).toEqual([1, 2]);
});

test("task allocation is independent of other tasks while snapshots still verify all evidence", async () => {
  const { store } = await setup();
  const first = await store.allocate(storeKey);
  const artifact = join(first.agent, "evidence.txt");
  await writeFile(artifact, "original");
  await store.commit(storeRecord(), await buildFileManifest(first.root, []));
  await writeFile(artifact, "changed");
  const nextKey = { ...storeKey, taskId: "b", attemptId: "b1" };
  const second = await store.allocate(nextKey);
  expect(JSON.parse(await readFile(join(second.root, "allocation.json"), "utf8"))).toMatchObject({ ordinal: 1, key: nextKey });
  const retry = await store.allocate({ ...nextKey, attemptId: "b2" });
  expect(JSON.parse(await readFile(join(retry.root, "allocation.json"), "utf8"))).toMatchObject({ ordinal: 2 });
  await expect(store.snapshot()).rejects.toThrow(/digest|checksum|changed/i);
  await expect(store.listAttempts()).rejects.toThrow(/digest|checksum|changed/i);
});

test("changed file bytes cannot be committed using an old checksum", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  await writeFile(join(paths.agent, "stderr.log"), "before");
  const files = await buildFileManifest(paths.root, []);
  await writeFile(join(paths.agent, "stderr.log"), "after");
  await expect(store.commit(storeRecord(), files)).rejects.toThrow(/digest|checksum|changed/i);
  expect((await store.snapshot()).records).toEqual([]);
});

test("failed result rename never makes an attempt visible to snapshots", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  // A real filesystem obstruction at the final commit point; no mocked RunStore methods.
  await mkdir(join(paths.root, "result.json"));
  await expect(store.commit(storeRecord(), { files: [], missing: [] })).rejects.toThrow(/STORE_WRITE_FAILED/);
  await rm(join(paths.root, "result.json"), { recursive: true });
  expect((await store.snapshot()).records).toEqual([]);
  expect((await store.listAttempts())[0]?.record).toBeNull();
});

test("snapshots detect tampered committed evidence", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  await writeFile(join(paths.agent, "stderr.log"), "before");
  await store.commit(storeRecord(), await buildFileManifest(paths.root, []));
  await writeFile(join(paths.agent, "stderr.log"), "corrupt");
  await expect(store.snapshot()).rejects.toThrow(/digest|checksum|changed/i);
});

test("reports share snapshot digest and stale snapshot publication is rejected", async () => {
  const { store, runDir } = await setup(); const snapshot = await store.snapshot();
  await store.saveReportBundle(snapshot.digest, { rate: null }, "# Result", []);
  const metrics = JSON.parse(await readFile(join(runDir, "metrics.json"), "utf8")) as { snapshotDigest: string };
  expect(metrics.snapshotDigest).toBe(snapshot.digest);
  expect(await readFile(join(runDir, "report.md"), "utf8")).toContain(snapshot.digest);
  await store.updateRun({ durationMs: 1000 });
  await expect(store.saveReportBundle(snapshot.digest, {}, "stale", [])).rejects.toThrow(/snapshot|stale/i);
});

test("commit and remote import reject unversioned errors even on a record with current outcome fields", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  for (const code of ["INTERNAL_ERROR", "PLUGIN_PRIVATE_CODE"]) {
    const value = { ...storeRecord(), solve: null, verdict: null,
      executionStatus: "failed", scoreStatus: "invalid", cleanupStatus: "cleaned",
      errors: [{ phase: "solve", code, message: "invalid new record" }] };
    // JSON is an untyped boundary; bypass TypeScript deliberately to check runtime rejection.
    await expect(Reflect.apply(store.commit, store, [value, { files: [], missing: [] }])).rejects.toThrow(/errors/);
    await expect(Reflect.apply(store.importAttempt, store, [value, { files: [], missing: [] }, paths.root])).rejects.toThrow(/errors/);
  }
  expect((await store.listAttempts())[0]?.record).toBeNull();
});

test("local historical reads convert simple errors without rewriting the saved file", async () => {
  const { store, runDir } = await setup(); const paths = await store.allocate(storeKey);
  await store.commit(storeRecord(), { files: [], missing: [] });
  await store.close();
  const { executionStatus: _execution, scoreStatus: _score, cleanupStatus: _cleanup, ...oldRecord } = storeRecord();
  const historical = JSON.stringify({ ...oldRecord, status: "invalid", solve: null, verdict: null,
    errors: [{ phase: "solve", code: "PRIVATE_OLD_CODE", message: "old evidence" }] });
  await writeFile(join(paths.root, "result.json"), historical);
  const reopened = instance(); await reopened.open(runDir);
  const result = (await reopened.listAttempts())[0]?.record;
  expect(result?.errors[0]).toMatchObject({ schemaVersion: 1, code: "INTERNAL_ERROR", details: { originalCode: "PRIVATE_OLD_CODE" } });
  expect(await readFile(join(paths.root, "result.json"), "utf8")).toBe(historical);
});

test("partial collection preserves a valid verdict and explicit missing evidence", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  const record = storeRecord();
  record.collection.trajectory = "missing";
  record.errors.push(fixtureFailure("collect", "ARTIFACT_COLLECTION_INCOMPLETE", "runner did not produce a trajectory"));
  const manifest = await buildFileManifest(paths.root, ["agent/trajectory.jsonl"]);
  await store.commit(record, manifest);
  expect((await store.snapshot()).records[0]).toMatchObject({ executionStatus: "completed", verdict: { passed: true } });
  await expect(access(join(paths.root, "files.json"))).resolves.toBeUndefined();
});

test("commit rejects an inventory that omits a produced file", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  await writeFile(join(paths.agent, "stderr.log"), "must inventory");
  await expect(store.commit(storeRecord(), { files: [], missing: [] })).rejects.toThrow(/inventory|unlisted/i);
});

test("commit cannot follow a task parent replaced with an external junction", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  const parent = dirname(paths.root);
  const relocated = parent + "-relocated";
  await rename(parent, relocated);
  await symlink(relocated, parent, "junction");
  await expect(store.commit(storeRecord(), { files: [], missing: [] })).rejects.toThrow(/symlink/i);
  await expect(access(join(relocated, storeKey.attemptId, "result.json"))).rejects.toThrow();
});

test("a declared complete trajectory requires contiguous events, end and native session", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  const record = storeRecord(); record.collection.trajectory = "complete";
  await writeFile(join(paths.agent, "session.jsonl"), "{}\n");
  await writeFile(join(paths.agent, "trajectory.jsonl"), trajectoryLines([1, 3]));
  await expect(store.commit(record, await buildFileManifest(paths.root, []))).rejects.toThrow(/STORE_RECORD_INVALID/);
  expect((await store.snapshot()).records).toEqual([]);
  await writeFile(join(paths.agent, "trajectory.jsonl"), trajectoryLines());
  await store.commit(record, await buildFileManifest(paths.root, []));
  expect((await store.snapshot()).records[0]?.collection.trajectory).toBe("complete");
});

test("record identity uses key fields rather than JSON property insertion order", async () => {
  const { store } = await setup(); await store.allocate(storeKey);
  const record = storeRecord({ attemptId: storeKey.attemptId, taskId: storeKey.taskId, runId: storeKey.runId });
  await store.commit(record, { files: [], missing: [] });
  expect((await store.snapshot()).records[0]?.key).toEqual(storeKey);
});

test("a truncated object with only key and status is not a valid committed result", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  await store.commit(storeRecord(), { files: [], missing: [] });
  await writeFile(join(paths.root, "result.json"), JSON.stringify({ key: storeKey, status: "completed" }));
  await expect(store.snapshot()).rejects.toThrow(/STORE_RECORD_INVALID/);
});

test("malformed records are rejected before the final commit point", async () => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  const malformed = { ...storeRecord(), durationMs: -1 };
  await expect(store.commit(malformed, { files: [], missing: [] })).rejects.toThrow(/STORE_RECORD_INVALID/);
  await expect(access(join(paths.root, "result.json"))).rejects.toThrow();
});

test.each([
  '{"seq":1,"type":"end"}\n',
  trajectoryLines([1, 2], { ...storeKey, taskId: "another-task" }),
  trajectoryLines().replaceAll('"schemaVersion":1', '"schemaVersion":99'),
  trajectoryLines().replaceAll('"at":"2026-09-18T00:00:00.000Z"', '"at":"invalid"'),
])("incomplete or unrelated trajectory cannot claim complete (%#)", async contents => {
  const { store } = await setup(); const paths = await store.allocate(storeKey);
  await writeFile(join(paths.agent, "trajectory.jsonl"), contents);
  await writeFile(join(paths.agent, "session.jsonl"), "{}\n");
  const record = storeRecord(); record.collection.trajectory = "complete";
  await expect(store.commit(record, await buildFileManifest(paths.root, []))).rejects.toThrow(/STORE_RECORD_INVALID/);
});

test("rebuilding after interrupted report publication records the mixed digests", async () => {
  const { store, runDir } = await setup(); const first = await store.snapshot();
  await store.saveReportBundle(first.digest, {}, "# First", []);
  await store.updateRun({ durationMs: 20 }); const second = await store.snapshot();
  // Disk state after metrics B was renamed but the process died before publishing report B.
  await writeFile(join(runDir, "metrics.json"), JSON.stringify({ schemaVersion: 1, snapshotDigest: second.digest, metrics: {} }));
  await store.saveReportBundle(second.digest, {}, "# Rebuilt", []);
  const recovery = JSON.parse(await readFile(join(runDir, "report-recovery.json"), "utf8")) as Record<string, unknown>;
  expect(recovery).toMatchObject({ reason: "mixed-snapshots", metricsDigest: second.digest, reportDigest: first.digest, rebuiltDigest: second.digest });
  expect(await readFile(join(runDir, "report.md"), "utf8")).toContain(second.digest);
});

test("resume preserves prior reports and updates keep evidence links usable without new directories", async () => {
  const { store, runDir } = await setup();
  const paths = await store.allocate(storeKey);
  const record = storeRecord();
  await writeFile(join(paths.agent, "trajectory.jsonl"), trajectoryLines());
  await writeFile(join(paths.agent, "session.jsonl"), "{}\n");
  record.collection.trajectory = "complete";
  record.trajectory = "agent/trajectory.jsonl";
  await store.commit(record, await buildFileManifest(paths.root, []));
  await saveReport(store, [], new MarkdownReporter());
  const original = await readFile(join(runDir, "report.md"), "utf8");
  expect(await readdir(runDir)).not.toContain("reports");
  await saveReport(store, [], new MarkdownReporter(), "resume");
  for (const location of [runDir, join(runDir, "reports/initial"), join(runDir, "reports/resume-1")]) {
    const markdown = await readFile(join(location, "report.md"), "utf8");
    const links = [...markdown.matchAll(/\]\(([^)]+)\)/gu)].map(match => match[1]!).filter(link => !link.startsWith("#"));
    expect(links.some(link => link.endsWith("result.json"))).toBe(true);
    expect(links.some(link => link.endsWith("files.json"))).toBe(true);
    expect(links.some(link => link.endsWith("agent/trajectory.jsonl"))).toBe(true);
    for (const link of links) await access(resolve(location, link));
  }
  await saveReport(store, [], new MarkdownReporter());
  expect(await readFile(join(runDir, "reports/initial/report.md"), "utf8")).toContain("# Evaluator report");
  const archived = await readFile(join(runDir, "reports/resume-1/report.md"), "utf8");
  await store.updateRun({ durationMs: 12345 });
  await saveReport(store, [], new MarkdownReporter());
  expect(await readFile(join(runDir, "reports/resume-1/report.md"), "utf8")).not.toBe(archived);
  expect(await readFile(join(runDir, "reports/initial/report.md"), "utf8")).toBe(original.replace(/\]\((tasks\/|manifest.json|config.yaml)/gu, "](../../$1"));
  expect((await readdir(join(runDir, "reports"))).sort()).toEqual(["current.json", "initial", "resume-1"]);
  await saveReport(store, [], new MarkdownReporter(), "resume");
  expect(await readFile(join(runDir, "reports/resume-1/report.md"), "utf8")).not.toBe(archived);
  expect(await readdir(join(runDir, "reports"))).toContain("resume-2");
});

test("builtin local store is selected through Cordis and disposal releases its writer lock", async () => {
  const fixture = join(import.meta.dirname, "..", "fixtures", "plugins", "valid");
  const loaded = await loadConfig(join(fixture, "experiment.yaml"), { apiKey: "fixture-secret" }, {});
  loaded.experiment.store = { name: "local", config: {} };
  const components = await bootstrap(loaded, fixture, join(fixture, "cordis.patch.yaml"));
  const root = await mkdtemp(join(tmpdir(), "evaluator-store-plugin-")); roots.push(root);
  try {
    await components.store.create(root, storeRun, loaded.persisted);
    await components.store.allocate(storeKey);
    await components.store.commit(storeRecord(), { files: [], missing: [] });
  } finally { await components.dispose(); }
  const reopened = instance(); await reopened.open(join(root, storeRun.runId));
  expect((await reopened.snapshot()).records[0]?.verdict?.passed).toBe(true);
});

test("run identity is persisted, reopened and validated at the manifest boundary", async () => {
  const identity = { evaluator: { name: "ember-evaluator", version: "0.1.0" }, runtime: { node: "v24.0.0", platform: "linux", arch: "x64" } };
  const root = await mkdtemp(join(tmpdir(), "evaluator-store-identity-")); roots.push(root);
  const store = instance(); await store.create(root, { ...structuredClone(storeRun), identity }, {});
  await store.close(); const reopened = instance(); await reopened.open(join(root, storeRun.runId));
  expect((await reopened.snapshot()).run.identity).toEqual(identity);
  for (const invalid of [{}, { ...identity, extra: "x" }, { ...identity, evaluator: { name: "", version: "1" } }, { ...identity, runtime: { node: "v24", platform: "linux" } }]) {
    const other = await mkdtemp(join(tmpdir(), "evaluator-store-bad-identity-")); roots.push(other);
    await expect(instance().create(other, { ...structuredClone(storeRun), identity: invalid } as typeof storeRun, {}))
      .rejects.toMatchObject({ code: "STORE_RECORD_INVALID" });
  }
});


test("resume reports reject a directory junction outside the run", async () => {
  const { store, runDir } = await setup();
  const outside = await mkdtemp(join(tmpdir(), "report-outside-")); roots.push(outside);
  await symlink(outside, join(runDir, "reports"), process.platform === "win32" ? "junction" : "dir");
  const snapshot = await store.snapshot();
  await expect(store.saveReportBundle(snapshot.digest, {}, "# Report", [], "resume")).rejects.toThrow("Symlink evidence rejected");
  await expect(access(join(outside, "resume-1"))).rejects.toThrow();
});

test("resume relocates custom evidence links but keeps bundle links and external URLs", async () => {
  const { store, runDir } = await setup();
  await writeFile(join(runDir, "custom.log"), "saved evidence");
  const snapshot = await store.snapshot();
  const markdown = "[custom](custom.log) [metrics](metrics.json) [section](#details) [external](https://example.com/)";
  await store.saveReportBundle(snapshot.digest, {}, markdown, [], "resume");
  const report = await readFile(join(runDir, "reports/resume-1/report.md"), "utf8");
  expect(report).toContain("[custom](../../custom.log)");
  expect(report).toContain("[metrics](metrics.json)");
  expect(report).toContain("[section](#details)");
  expect(report).toContain("[external](https://example.com/)");
  await rm(join(runDir, "reports/resume-1"), { recursive: true });
  await store.saveReportBundle(snapshot.digest, {}, markdown, []);
  expect(await readFile(join(runDir, "reports/resume-1/report.md"), "utf8")).toBe(report);
  const outside = await mkdtemp(join(tmpdir(), "report-current-outside-")); roots.push(outside);
  await rm(join(runDir, "reports/resume-1"), { recursive: true });
  await symlink(outside, join(runDir, "reports/resume-1"), process.platform === "win32" ? "junction" : "dir");
  await expect(store.saveReportBundle(snapshot.digest, {}, markdown, [])).rejects.toThrow("Symlink evidence rejected");
  expect(await readdir(outside)).toEqual([]);
});
