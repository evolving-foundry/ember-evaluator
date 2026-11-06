import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { runCli } from "../../src/cli/main.js";
import { defaultNetworkConfigPath, loadNetworkConfig } from "../../src/config/network.js";

test("retry reads the edited default network YAML after the original source download failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retry-default-network-"));
  vi.stubEnv("TEST_KEY", "fixture-secret");
  try {
    await loadNetworkConfig();
    await writeFile(defaultNetworkConfigPath(), "{}");
    await writeFile(join(directory, "source.mjs"), `
export const inject = ["evaluator"];
export function apply(ctx) {
  ctx.evaluator.register("benchmark", "network-fixture", value => value, (_config, runtime) => ({
    async resolveSource() {
      if (runtime.network.settings.sources.huggingface !== "https://repaired.test")
        throw Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
      return { source: "fixture", revision: "fixed", files: [], metadata: {} };
    },
    async *enumerate() { yield { id: "one", recordKey: 0 }; },
    async prepare() { return { input: { id: "one", prompt: "Question" }, verification: null,
      solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null }; },
    async verify() { return { score: 1, passed: true, details: {} }; }
  }));
}
`);
    const patch = join(directory, "patch.yaml"), file = join(directory, "experiment.yaml");
    await writeFile(patch, stringify([{ insert: [
      { id: "source", name: "./source.mjs" },
      { id: "solver", name: fileURLToPath(new URL("../fixtures/cli/plugin.mjs", import.meta.url)) },
    ] }]));
    await writeFile(file, stringify({ services: { default: { model: "fixture", base_url: "https://model.invalid", api_key: "${TEST_KEY}" } },
      benchmark: { name: "network-fixture", solver: "cli-fixture" }, environment: "local", output: { directory: "./results" } }));
    const out: string[] = [], errors: string[] = [];
    const io = { out: (text: string) => out.push(text), error: (text: string) => errors.push(text) };
    expect(await runCli(["run", file, "--patch", patch], io), errors.join("\n")).toBe(1);
    const run = out.at(-1)!;
    expect(JSON.parse(await readFile(join(run, "manifest.json"), "utf8")).failure.code).toBe("NETWORK_FAILURE");
    await writeFile(defaultNetworkConfigPath(), "sources:\n  huggingface: https://repaired.test\n");
    expect(await runCli(["retry", "--run", run], io), errors.join("\n")).toBe(0);
    expect(JSON.parse(await readFile(join(run, "manifest.json"), "utf8")).status).toBe("completed");
  } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
