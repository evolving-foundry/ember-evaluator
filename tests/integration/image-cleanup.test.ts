import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli/main.js";

test("cleanup loads only scheduler and environment, without dataset, Solver, model key or result allocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-cli-test-"));
  try {
    await writeFile(join(root, "plugin.mjs"), `
import { writeFile } from "node:fs/promises";
export const inject = ["evaluator"];
export function apply(ctx) {
  ctx.evaluator.register("benchmark", "cleanup-fixture", value => value, () => { throw Error("Benchmark factory must not run"); });
  ctx.evaluator.register("solver", "cleanup-fixture", value => value, () => { throw Error("Solver factory must not run"); });
  ctx.evaluator.register("environment", "cleanup-fixture", value => value, (_config, runtime) => ({
    async cleanupImages(request) {
      await writeFile(runtime.resolvePath("request.json"), JSON.stringify({request, fingerprint:runtime.imageConfigFingerprint}));
      return {nodeId:"local", daemonId:"fixture", items:[]};
    }
  }));
}
`);
    const file = join(root, "experiment.yaml"), patch = join(root, "patch.yaml");
    await writeFile(patch, JSON.stringify([{ insert: [{ id: "cleanup-fixture", name: "./plugin.mjs" }] }]));
    await writeFile(file, JSON.stringify({ benchmark: { name: "cleanup-fixture", solver: { name: "cleanup-fixture" } },
      environment: { name: "cleanup-fixture" }, services: { default: { model: "fixture", base_url: "http://127.0.0.1:1", api_key: "${UNSET_CLEANUP_MODEL_KEY}" } }, output: { directory: "./results" } }));
    const output: string[] = [], errors: string[] = [];
    const code = await runCli(["cleanup", "images", file, "--patch", patch], { out: value => output.push(value), error: value => errors.push(value) });
    expect(code, errors.join("\n")).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({ preview: true, nodes: [{ nodeId: "local" }] });
    const record = JSON.parse(await readFile(join(root, "request.json"), "utf8"));
    expect(record.request).toMatchObject({ all: false, execute: false, configFingerprint: record.fingerprint });
    await expect(access(join(root, "results"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
