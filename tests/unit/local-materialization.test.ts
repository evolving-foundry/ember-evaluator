import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import type { EnvironmentSpec, RuntimeInstallation } from "../../src/core/contracts/environment.js";

test("shared local preparation reuses probes, isolates receipts and revalidates changed configurations", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-materialization-"));
  try {
    const counter = join(root, "count.txt");
    const installation: RuntimeInstallation = {
      id: "fixture", localRoot: root, files: [], commands: [],
      probes: [{ executable: "node", args: ["-e", "require('node:fs').appendFileSync(process.argv[1], 'x')", counter] }],
    };
    const spec: EnvironmentSpec = { workdir: ".", image: null, initialFiles: [], runtime: [], installation };
    const signal = new AbortController().signal;
    const environment = new LocalEnvironment();
    const first = await environment.materialize(spec, signal);
    const resolved = await realpath(root);
    expect(first.prepared).toMatchObject({ kind: "local", runtime: { root: resolved, persistent: true } });
    const receipt = first.prepared;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Missing receipt");
    const runtime = receipt.runtime;
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) throw new Error("Missing runtime");
    runtime.root = "modified-by-caller";
    const second = await environment.materialize(spec, signal);
    expect(second.prepared).toMatchObject({ kind: "local", runtime: { root: resolved } });
    expect(await readFile(counter, "utf8")).toBe("x");
    installation.id = "fixture-v2";
    await environment.materialize(spec, signal);
    expect(await readFile(counter, "utf8")).toBe("xx");
    await new LocalEnvironment().materialize(spec, signal);
    expect(await readFile(counter, "utf8")).toBe("xxx");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed and cancelled preparation never become cached successes", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-materialization-retry-"));
  try {
    const counter = join(root, "count.txt");
    const installation: RuntimeInstallation = {
      id: "fixture", localRoot: root, files: [], commands: [],
      probes: [{ executable: "node", args: ["-e", "const f=require('node:fs'),p=process.argv[1];if(!f.existsSync(p)){f.writeFileSync(p,'first');process.exit(1)}f.appendFileSync(p,'-retry')", counter] }],
    };
    const spec: EnvironmentSpec = { workdir: ".", image: null, initialFiles: [], runtime: [], installation };
    const environment = new LocalEnvironment();
    const signal = new AbortController().signal;
    await expect(environment.materialize(spec, signal)).rejects.toThrow();
    await environment.materialize(spec, signal);
    expect(await readFile(counter, "utf8")).toBe("first-retry");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(environment.materialize(spec, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(counter, "utf8")).toBe("first-retry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
