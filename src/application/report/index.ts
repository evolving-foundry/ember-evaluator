import { resolveRunStatus } from "../../core/results/task-result-resolver.js";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { Metrics } from "../../core/contracts/metrics.js";
import type { Reporter } from "../../core/contracts/reporter.js";
import type { RunStore } from "../../core/contracts/run-store.js";
import type { RunManifest } from "../../core/contracts/result.js";
import { DEFAULT_METRICS } from "../../config/defaults.js";
import { expectRecord, parseSelection } from "../../core/validation/input.js";
import { resolvePlugin } from "../../config/plugin-patch.js";
import { apply as registry } from "../plugins/registry.js";
import * as reporting from "../../plugins/reporting.js";
import { aggregateMetrics } from "../../plugins/metrics/aggregate.js";
import { LocalRunStore } from "../../plugins/stores/local.js";
import { taskReportSnapshot } from "./snapshot.js";
import type { TaskReportDocument } from "../../core/contracts/reporter.js";

export async function saveReport(store: RunStore, metrics: Metrics[], reporter: Reporter, mode: "update" | "resume" = "update"): Promise<void> {
  const snapshot = await store.snapshot();
  const values = await aggregateMetrics(snapshot, metrics);
  const targets = reporter.taskReports?.(structuredClone(snapshot), structuredClone(values)) ?? [];
  const documents: TaskReportDocument[] = [];
  if (typeof store.saveReportBundle !== "function") throw new TypeError("RunStore must implement saveReportBundle()");
  const ids = new Set<string>(), tasks = new Set<string>();
  for (const target of targets) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(target.id) || ids.has(target.id.toLowerCase()) || tasks.has(target.taskId))
      throw new TypeError("Invalid or duplicate task report target");
    ids.add(target.id.toLowerCase()); tasks.add(target.taskId);
    const scoped = taskReportSnapshot(snapshot, target.taskId);
    const selected = await aggregateMetrics(scoped, metrics);
    documents.push({ ...target, snapshotDigest: scoped.digest, metrics: selected,
      markdown: await reporter.render(structuredClone(scoped), structuredClone(selected),
        { taskId: target.taskId, evidenceRoot: "../../" }) });
  }
  const markdown = await reporter.render(structuredClone(snapshot), structuredClone(values));
  await store.saveReportBundle(snapshot.digest, values, markdown, documents, mode);
}

async function loadReporting(manifest: RunManifest, runDir: string) {
  const saved = expectRecord(
    parse(await readFile(join(runDir, "config.yaml"), "utf8"), { maxAliasCount: 100 }),
    "saved configuration",
  );
  const metrics = saved.metrics === undefined ? [...DEFAULT_METRICS] : saved.metrics;
  if (!Array.isArray(metrics)) throw new TypeError("saved metrics must be a list");
  const selections = metrics.map((value, index) => parseSelection(value, `metrics[${index}]`));
  const reporter = parseSelection(saved.reporter ?? { name: "markdown", config: {} }, "reporter");
  const ctx = new Context();
  try {
    await ctx.plugin(registry);
    await ctx.plugin(reporting);
    const directory = resolve(manifest.pluginRuntime?.configDirectory ?? runDir);
    const patchPath = manifest.pluginRuntime?.patchPath ?? join(directory, "cordis.patch.yaml");
    const providers = new Set<string>();
    for (const selection of [
      ...selections.map(selection => ({ role: "metrics" as const, name: selection.name })),
      { role: "reporter" as const, name: reporter.name },
    ]) {
      if (ctx.evaluator.has(selection.role, selection.name)) continue;
      const provider = manifest.pluginRuntime?.reportingProviders?.[`${selection.role}:${selection.name}`];
      if (!provider)
        throw new Error(`Saved run lacks reporting provider metadata: ${selection.role}:${selection.name}`);
      providers.add(provider);
    }
    for (const id of providers) {
      const entry = manifest.pluginRuntime?.entries.find(entry => entry.id === id);
      if (!entry) throw new Error(`Missing reporting plugin entry: ${id}`);
      const plugin = await resolvePlugin(entry, patchPath);
      if (manifest.pluginVersions[entry.id] !== plugin.version)
        throw new Error(`Plugin version differs from saved run: ${entry.id}`);
      await ctx.plugin(plugin.plugin as Plugin);
    }
    const createMetrics = selections.map(selection => ctx.evaluator.prepare("metrics", selection));
    const createReporter = ctx.evaluator.prepare("reporter", reporter);
    const runtime = {
      configDirectory: directory,
      resolvePath: (path: string) => resolve(directory, path),
    };
    const instances: Metrics[] = [];
    for (const create of createMetrics) instances.push(await create(runtime));
    return { metrics: instances, reporter: await createReporter(runtime), dispose: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export async function rebuildReport(runDir: string): Promise<void> {
  const store = new LocalRunStore();
  try {
    const manifest = await store.open(resolve(runDir));
    if (manifest.status !== "running" && manifest.status !== "cancelled") {
      const snapshot = await store.snapshot();
      const status = resolveRunStatus(snapshot);
      if (status !== manifest.status) await store.updateRun({ status });
    }
    const reporting = await loadReporting(manifest, resolve(runDir));
    try {
      await saveReport(store, reporting.metrics, reporting.reporter);
    } finally {
      await reporting.dispose();
    }
  } finally {
    await store.close();
  }
}
