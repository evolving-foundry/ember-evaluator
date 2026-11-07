import { join, resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";

import { bootstrap } from "../../src/application/plugins/bootstrap.js";
import { loadConfig as readConfig } from "../../src/application/config.js";
// These tests exercise assembly validation separately from structural configuration loading.
const loadConfig = (path: string, overrides: Parameters<typeof readConfig>[1], env: Parameters<typeof readConfig>[2]) =>
  readConfig(path, overrides, { FIXTURE_KEY: "fixture-secret", ...env }, { validatePlugins: false });
import { loadPluginPatch } from "../../src/config/plugin-patch.js";
import { loadPluginModule } from "../../src/application/plugins/load-module.js";
import { apply as registryPlugin } from "../../src/application/plugins/registry.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { SimpleAgentSolver } from "../../src/plugins/solvers/simpleagent.js";
import { HarborBenchmark } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/index.js";
import { mixedSnapshot } from "../fixtures/results/mixed-run/fixture.js";
import { PACKAGE_RUNTIME_ID } from "../../src/core/results/runtime-identity.js";
import { loadPackageDigest } from "../../src/infrastructure/provenance/package.js";

type FixtureState = {
  created: string[];
  disposed: string[];
  factoryInputs: Array<{
    role: string;
    config: unknown;
    auth: string | null;
    configDirectory: string | null;
    resolvedPath: string | null;
  }>;
};

const fixture = (...parts: string[]) =>
  join(import.meta.dirname, "..", "fixtures", "plugins", ...parts);

function bootstrapWithPatch(config: Parameters<typeof bootstrap>[0], directory: string) {
  return bootstrap(config, directory, join(directory, "cordis.patch.yaml"));
}

function state(): FixtureState {
  return (globalThis as typeof globalThis & { __t02FixtureState?: FixtureState })
    .__t02FixtureState ??= { created: [], disposed: [], factoryInputs: [] };
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { __t02FixtureState?: FixtureState })
    .__t02FixtureState;
});

describe("Cordis evaluator registry", () => {
  test("rolls back a registration when plugin apply fails", async () => {
    const ctx = new Context();
    await ctx.plugin(registryPlugin);

    const failing = {
      inject: ["evaluator"],
      apply(pluginContext: Context) {
        pluginContext.evaluator.register(
          "metrics",
          "orphan",
          () => ({}),
          () => ({ name: "orphan", async compute() { return null; } }),
        );
        throw new Error("apply failed after register");
      },
    };

    await expect(ctx.plugin(failing)).rejects.toThrow("apply failed after register");
    expect(ctx.evaluator.has("metrics", "orphan")).toBe(false);
    await ctx.fiber.dispose();
  });

  test("removes direct registrations when their caller plugin unloads", async () => {
    const ctx = new Context();
    await ctx.plugin(registryPlugin);
    const plugin = {
      inject: ["evaluator"],
      apply(pluginContext: Context) {
        pluginContext.evaluator.register(
          "metrics",
          "temporary",
          () => ({}),
          () => ({ name: "temporary", async compute() { return null; } }),
        );
      },
    };

    const fiber = ctx.plugin(plugin);
    await fiber;
    expect(ctx.evaluator.has("metrics", "temporary")).toBe(true);
    await fiber.dispose();
    expect(ctx.evaluator.has("metrics", "temporary")).toBe(false);
    await ctx.fiber.dispose();
  });

  test("rejects duplicate role and name registrations without an orphan", async () => {
    const ctx = new Context();
    await ctx.plugin(registryPlugin);
    const first = ctx.plugin({
      inject: ["evaluator"],
      apply(pluginContext: Context) {
        pluginContext.evaluator.register(
          "metrics",
          "duplicate",
          () => ({}),
          () => ({ name: "first", async compute() { return null; } }),
        );
      },
    });
    await first;

    await expect(ctx.plugin({
      inject: ["evaluator"],
      apply(pluginContext: Context) {
        pluginContext.evaluator.register(
          "metrics",
          "duplicate",
          () => ({}),
          () => ({ name: "second", async compute() { return null; } }),
        );
      },
    })).rejects.toThrow(/duplicate/i);

    expect(ctx.evaluator.has("metrics", "duplicate")).toBe(true);
    await first.dispose();
    expect(ctx.evaluator.has("metrics", "duplicate")).toBe(false);
    await ctx.fiber.dispose();
  });
});

describe("bootstrap", () => {
  test("returns no entries when no patch file is selected", async () => {
    const loaded = await loadPluginPatch();
    expect(loaded.entries).toEqual([]);
    expect(loaded.patchDigest).toBeNull();
    expect(loaded.patchPath).toBeNull();
  });

  test("loads the patch file selected by its explicit path", async () => {
    const patchPath = fixture("valid", "cordis.patch.yaml");
    const loaded = await loadPluginPatch(patchPath);
    expect(loaded.entries.map(entry => entry.id)).toEqual(["fixture-seven-roles"]);
    expect(loaded.patchPath).toBe(resolve(patchPath));
  });

  test("rejects an explicitly selected patch that does not exist", async () => {
    await expect(loadPluginPatch(fixture("valid", "missing.patch.yaml"))).rejects.toThrow();
  });

  test("records the distributed builtin runner lock with plugin versions", async () => {
    const loaded = await loadConfig(fixture("valid", "experiment.yaml"), { apiKey: "fixture-secret" }, {});
    const components = await bootstrapWithPatch(loaded, fixture("valid"));
    try {
      expect(components.pluginVersions["ember-evaluator:builtin-runtime"])
        .toMatch(/^sha256:[a-f0-9]{64}$/u);
    } finally { await components.dispose(); }
  });

  test("records only the selected reporting role providers for offline reconstruction", async () => {
    const loaded = await loadConfig(fixture("valid", "experiment.yaml"), { apiKey: "fixture-secret" }, {});
    const components = await bootstrapWithPatch(loaded, fixture("valid"));
    try {
      expect(components.pluginRuntime?.reportingProviders).toEqual({
        "metrics:fixture-metrics": "fixture-seven-roles", "reporter:fixture-reporter": "fixture-seven-roles",
      });
    } finally { await components.dispose(); }
  });
  test("selects builtin simpleagent with runtime model/auth and rejects private config", async () => {
    const loaded = await loadConfig(fixture("valid", "experiment.yaml"), { apiKey: "fixture-secret" }, {});
    loaded.experiment.solver = { name: "simpleagent", config: {}, service: "default" };
    const components = await bootstrapWithPatch(loaded, fixture("valid"));
    try {
      expect(components.solver).toBeInstanceOf(SimpleAgentSolver);
      expect(components.solver.requirements().map(requirement => requirement.name)).toEqual(["node", "shell"]);
    } finally { await components.dispose(); }
    loaded.experiment.solver.config = { apiKey: "wrong-place" };
    await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/simpleagent/);
  });

  test("selects all default metrics and Markdown reporting as real builtin plugins", async () => {
    const loaded = await loadConfig(fixture("valid", "experiment.yaml"), { apiKey: "fixture-secret" }, {});
    loaded.experiment.metrics = ["success-rate", "duration", "usage"].map(name => ({ name, config: {} }));
    loaded.experiment.reporter = { name: "markdown", config: {} };
    const components = await bootstrapWithPatch(loaded, fixture("valid"));
    try {
      expect(components.metrics.map(metric => metric.name)).toEqual(["success-rate", "duration", "usage"]);
      expect(await components.metrics[0]!.compute(mixedSnapshot)).toMatchObject({ selected: 4, passed: 1, rate: 1 / 3 });
      expect(await components.reporter.render(mixedSnapshot, {})).toContain("未完成");
    } finally { await components.dispose(); }
  });

  test("selects builtin local scheduling and rejects invalid concurrency before execution", async () => {
    const loaded = await loadConfig(fixture("valid", "experiment.yaml"), { apiKey: "fixture-secret" }, {});
    loaded.experiment.scheduler = { name: "local", config: { concurrency: 2 } };
    const components = await bootstrapWithPatch(loaded, fixture("valid"));
    try {
      expect(components.scheduler).toBeInstanceOf(LocalScheduler);
      expect(components.pluginVersions[PACKAGE_RUNTIME_ID]).toBe(await loadPackageDigest());
    }
    finally { await components.dispose(); }
    loaded.experiment.scheduler.config = { concurrency: 0 };
    await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/concurrency/);
  });

  test("selects the builtin local environment and validates its config", async () => {
    const loaded = await loadConfig(fixture("valid", "experiment.yaml"), { apiKey: "fixture-secret" }, {});
    loaded.experiment.environment = { name: "local", config: {} };
    const components = await bootstrapWithPatch(loaded, fixture("valid"));
    try { expect(components.environment).toBeInstanceOf(LocalEnvironment); }
    finally { await components.dispose(); }
    loaded.experiment.environment.config = { arbitrary: true };
    await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/local.*empty/);
  });

  test("selects Docker without starting the daemon and rejects unknown config", async () => {
    const loaded = await loadConfig(fixture("valid", "experiment.yaml"), { apiKey: "fixture-secret" }, {});
    loaded.experiment.environment = { name: "docker", config: { dockerExecutable: "not-installed-fixture-docker",
      imageOverrides: { "fixture/base:1": "fixture/public-cache:1" } } };
    const components = await bootstrapWithPatch(loaded, fixture("valid"));
    try { expect(components.environment).toBeInstanceOf(DockerEnvironment); }
    finally { await components.dispose(); }
    loaded.experiment.environment.config = { pullProxy: "socks5://localhost:7890" };
    await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/pullProxy/);
    loaded.experiment.environment.config = { privileged: true };
    await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/privileged/);
    for (const platform of ["auto", "linux/amd64", "linux/arm64"]) {
      loaded.experiment.environment.config = { platform };
      const selected = await bootstrapWithPatch(loaded, fixture("valid"));
      try { expect(selected.environment).toBeInstanceOf(DockerEnvironment); }
      finally { await selected.dispose(); }
    }
    loaded.experiment.environment.config = { platform: "linux/386" };
    await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/platform/);
    loaded.experiment.environment.config = { imageOverrides: { "fixture/base:1": false } };
    await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/imageOverrides/);
    loaded.experiment.environment.config = { nodeImage: PINNED_NODE_IMAGE };
    const pinned = await bootstrapWithPatch(loaded, fixture("valid"));
    await pinned.dispose();
    loaded.experiment.environment.config = { nodeImage: "node:24" };
    await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/nodeImage.*pinned/i);
  });

  test("registers reusable verifiers and rejects retired benchmark entrypoints", async () => {
    const loaded = await loadConfig(fixture("valid", "experiment.yaml"), { apiKey: "fixture-secret" }, {});
    loaded.experiment.benchmark = { name: "harbor", config: {} };
    for (const name of ["harbor-shell", "harbor-python"]) {
      loaded.experiment.verifier = { name, config: {} };
      const components = await bootstrapWithPatch(loaded, fixture("valid"));
      await components.dispose();
    }
    loaded.experiment.verifier = { name: "harbor-python", config: { requireService: true } };
    await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/explicit verifier.service/);
    delete loaded.experiment.verifier;
    for (const name of ["workbuddybench", "deepswebench"]) {
      loaded.experiment.benchmark = { name, config: {} };
      await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow(/unknown benchmark/);
    }
  });

  test("loads Harbor source and verifier without downloading or starting containers", async () => {
    const loaded = await loadConfig(fixture("valid", "experiment.yaml"), { apiKey: "fixture-secret" }, {});
    loaded.experiment.benchmark = { name: "harbor", config: { dataset: "terminal-bench@2.0", cacheDir: "./harbor-cache", taskProfiles: { custom: { workdir: "/app", extraPaths: ["/data"] } } } };
    const components = await bootstrapWithPatch(loaded, fixture("valid"));
    try { expect(components.benchmark).toBeInstanceOf(HarborBenchmark); expect(typeof components.benchmark.verify).toBe("function"); }
    finally { await components.dispose(); }
    for (const config of [{ dataset: "terminal-bench@2.0", unexpected: true }, { dataset: "terminal-bench@2.0", taskProfiles: { custom: { workdir: "/", extraPaths: [] } } }, { dataset: "terminal-bench@2.0", taskProfiles: { custom: { workdir: "/app", extraPaths: [], mounts: [] } } }]) {
      loaded.experiment.benchmark.config = config;
      await expect(bootstrapWithPatch(loaded, fixture("valid"))).rejects.toThrow();
    }
  });

  test("instantiates third-party plugins for all seven roles", async () => {
    const loaded = await loadConfig(
      fixture("valid", "experiment.yaml"),
      { apiKey: "fixture-secret" },
      {},
    );

    const components = await bootstrapWithPatch(loaded, fixture("valid"));

    expect(state().created).toEqual([
      "benchmark",
      "environment",
      "solver",
      "metrics",
      "reporter",
      "store",
      "scheduler",
    ]);
    expect(state().factoryInputs).toHaveLength(7);
    expect(state().factoryInputs.every(({ role, auth }) => auth === (["metrics", "reporter"].includes(role) ? null : "fixture-secret"))).toBe(true);
    expect(Object.keys(components.pluginVersions)).toContain("fixture-seven-roles");
    await components.dispose();
    expect(state().disposed).toContain("fixture-seven-roles");
  });

  test("gives path-owning plugins an experiment-relative resolver", async () => {
    const loaded = await loadConfig(
      fixture("valid", "experiment.yaml"),
      { apiKey: "fixture-secret" },
      {},
    );
    expect(loaded.experiment.benchmark.config.cacheDir).toBe("./cache");

    const components = await bootstrapWithPatch(loaded, fixture("valid"));
    const benchmarkInput = state().factoryInputs.find(({ role }) => role === "benchmark");

    expect(benchmarkInput?.configDirectory).toBe(fixture("valid"));
    expect(benchmarkInput?.resolvedPath).toBe(fixture("valid", "cache"));
    await components.dispose();
  });

  test("hands plugin-private configuration to the registration validator", async () => {
    const loaded = await loadConfig(
      fixture("invalid-private", "experiment.yaml"),
      {},
      {},
    );

    await expect(bootstrapWithPatch(loaded, fixture("invalid-private")))
      .rejects.toThrow(/benchmark.*marker/i);
    expect(state().created).toEqual([]);
    expect(state().disposed).toContain("fixture-seven-roles");
  });

  test("validates every selected plugin before invoking any factory", async () => {
    const loaded = await loadConfig(
      fixture("invalid-late-private", "experiment.yaml"),
      {},
      {},
    );

    await expect(bootstrapWithPatch(loaded, fixture("invalid-late-private")))
      .rejects.toThrow(/scheduler.*marker/i);
    expect(state().created).toEqual([]);
    expect(state().disposed).toContain("fixture-seven-roles");
  });

  test("disposes started plugin effects after a later factory fails", async () => {
    const loaded = await loadConfig(
      fixture("factory-failing", "experiment.yaml"),
      {},
      {},
    );

    await expect(bootstrapWithPatch(loaded, fixture("factory-failing")))
      .rejects.toThrow("fixture environment factory failed");
    expect(state().created).toEqual(["benchmark"]);
    expect(state().disposed).toContain("factory-failing");
  });

  test("a plugin apply failure after register leaves no live effects", async () => {
    const loaded = await loadConfig(
      fixture("failing", "experiment.yaml"),
      {},
      {},
    );

    await expect(bootstrapWithPatch(loaded, fixture("failing")))
      .rejects.toThrow("fixture apply failed");
    expect(state().disposed).toContain("failing");
  });

  test("rejects duplicate fixture registrations and unloads both scopes", async () => {
    const loaded = await loadConfig(
      fixture("duplicate", "experiment.yaml"),
      {},
      {},
    );

    await expect(bootstrapWithPatch(loaded, fixture("duplicate")))
      .rejects.toThrow(/duplicate.*benchmark.*fixture-benchmark/i);
    expect(state().disposed).toEqual(expect.arrayContaining([
      "duplicate-first",
      "duplicate-second",
    ]));
  });

  test("resolves npm package entries from the patch project", async () => {
    const resolved = await loadPluginModule(
      { id: "yaml-package", name: "yaml" },
      fixture("valid", "cordis.patch.yaml"),
    );

    expect(resolved.id).toBe("yaml-package");
    expect(resolved.version).toBe("2.9.1");
    expect(resolved.plugin).toBeTruthy();
  });

  test("reserves the patch metadata id from plugin entries", async () => {
    await expect(loadPluginPatch(fixture("metadata-collision", "cordis.patch.yaml")))
      .rejects.toThrow(/cordis\.patch\.yaml.*reserved/i);
  });

  test("reserves the builtin runtime provenance id from plugin entries", async () => {
    await expect(loadPluginPatch(fixture("builtin-collision", "cordis.patch.yaml")))
      .rejects.toThrow(/builtin-runtime.*reserved/i);
  });
});
