import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { runEngine } from "../../src/index.js";
import * as pluginRegistry from "../../src/application/plugins/open-registry.js";
import { harness } from "../fixtures/engine/fakes.js";

test("public runEngine uses caller components without loading plugins or disposing caller ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-public-engine-"));
  const value = harness(root);
  const open = vi.spyOn(pluginRegistry, "openPluginRegistry").mockImplementation(async () => { throw new Error("unexpected plugin loading"); });
  const solve = vi.spyOn(value.components.solver, "solve");
  try {
    const result = await runEngine({ components: value.components, config: value.config, signal: new AbortController().signal });
    expect(result.run.status).toBe("completed");
    expect(result.run.pluginVersions).toEqual({ fixture: "1" });
    expect(solve).toHaveBeenCalledTimes(3);
    expect(open).not.toHaveBeenCalled();
    expect((await value.components.store.snapshot()).records).toHaveLength(3);
  } finally {
    open.mockRestore();
    await value.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
