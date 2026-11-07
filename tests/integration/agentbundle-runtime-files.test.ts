import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseInstalledBundle } from "../../src/runtimes/agentbundle/cli.js";
import { agentBundleRuntimeFiles } from "../../src/runtimes/agentbundle/runtime-files.js";
import { AGENT_BUNDLE_CORE_VERSION } from "../../src/runtimes/agentbundle/sdk.js";
import { dshRuntimeInstallation } from "../../src/runtimes/dsh/runtime.js";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";
import { copyRuntimeInventory, runtimeInventory } from "../../src/infrastructure/runtime-installation/install.js";

const execFileAsync = promisify(execFile);

// These tests hash/copy a full SDK and spawn Node processes. Keep an explicit
// I/O budget so parallel Windows filesystem activity does not use the 5s unit-test default.
describe("AgentBundle SDK runtime files", () => {
  it("copies a runnable core package into an isolated runtime", async () => {
    const signal = AbortSignal.timeout(20_000);
    const files = await agentBundleRuntimeFiles();
    const inventory = await runtimeInventory({ id: "agentbundle-test", files, commands: [], probes: [] }, process.platform, signal);
    const root = await mkdtemp(join(tmpdir(), "agentbundle-runtime-test-"));
    try {
      await copyRuntimeInventory(inventory, root, signal);
      const { stdout } = await execFileAsync(process.execPath, [join(root, "agentbundle", "run.mjs"), "--version"]);
      expect(stdout.trim()).toBe(AGENT_BUNDLE_CORE_VERSION);
      const bundle = join(root, "fixture-bundle");
      await mkdir(join(bundle, "plugins", "probe"), { recursive: true });
      await writeFile(join(bundle, "bundle.yaml"), [
        "kind: dsh-agent-bundle",
        "schemaVersion: 1",
        "name: probe-demo",
        "harness:",
        "  name: dsh",
        '  version: ">=0.2.2-rc.1 <0.3"',
        "plugins:",
        "  - path: ./plugins/probe",
      ].join("\n") + "\n");
      await writeFile(join(bundle, "agent.yaml"), "model:\n  provider: test-provider\n  model: test-model\n");
      await writeFile(join(bundle, "dependencies.lock"), "# placeholder\n");
      await writeFile(join(bundle, "plugins", "probe", "package.json"), JSON.stringify({
        name: "@dsh-bundle-test/probe", version: "1.0.0", main: "index.js",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }));
      await writeFile(join(bundle, "plugins", "probe", "index.js"), "export const probe = true;\n");
      await writeFile(join(bundle, "plugins", "probe", "cordis.patch.yml"), "- insert: []\n");
      const verified = await execFileAsync(process.execPath, [
        join(root, "agentbundle", "run.mjs"), "--json", "verify", bundle,
        "--harness-version", "0.2.2-rc.1",
      ]);
      expect(JSON.parse(verified.stdout)).toMatchObject({ harness: { name: "dsh", actualVersion: "0.2.2-rc.1" } });
      const solver = new AgentBundleSolver(
        bundle,
        { name: "fixture-model", endpoint: "http://localhost", provider: null, api: "openai-completions" },
        { value: "fixture-key", reference: null },
        {
          installation: async () => ({ id: "fixture-runtime", files: [], commands: [], probes: [] }),
        },
      );
      await expect(solver.provenance(signal)).resolves.toMatchObject({
        bundle: JSON.parse(verified.stdout).digest,
        harness: "dsh",
        cliVersion: AGENT_BUNDLE_CORE_VERSION,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("returns the Pi coding-agent-dir from install JSON", async () => {
    const signal = new AbortController().signal;
    const files = await agentBundleRuntimeFiles();
    const inventory = await runtimeInventory({ id: "agentbundle-pi-install-test", files, commands: [], probes: [] }, process.platform, signal);
    const root = await mkdtemp(join(tmpdir(), "agentbundle-pi-install-"));
    try {
      await copyRuntimeInventory(inventory, root, signal);
      const bundle = join(root, "pi-bundle");
      await mkdir(join(bundle, "agent"), { recursive: true });
      await mkdir(join(bundle, "skills", "demo"), { recursive: true });
      await mkdir(join(bundle, "extensions", "demo"), { recursive: true });
      await writeFile(join(bundle, "bundle.yaml"), [
        "kind: pi-agent-bundle",
        "schemaVersion: 1",
        "name: probe-pi",
        "harness:",
        "  name: pi",
        '  version: ">=0.1 <0.2"',
        "instructions: ./agent/instructions.md",
        "skills: ./skills",
        "extensions:",
        "  - ./extensions/demo",
        "settings: ./settings.json",
      ].join("\n") + "\n");
      await writeFile(join(bundle, "agent", "instructions.md"), "# probe\n");
      await writeFile(join(bundle, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Fixture skill for runtime installation.\n---\n# skill\n");
      await writeFile(join(bundle, "settings.json"), "{}\n");
      await writeFile(join(bundle, "extensions", "demo", "package.json"), JSON.stringify({
        name: "probe-extension",
        pi: { extensions: ["./extension.js"] },
      }));
      await writeFile(join(bundle, "extensions", "demo", "extension.js"), "export default function extension() {}\n");
      const state = join(root, "state");
      const home = join(state, "home");
      await mkdir(state, { recursive: true });
      const installed = await execFileAsync(process.execPath, [
        join(root, "agentbundle", "run.mjs"), "--json", "install", bundle,
        "--harness-version", "0.1.0",
        "--home", home,
        "--profile", "pi",
      ], {
        env: {
          ...process.env,
          HOME: state,
          USERPROFILE: state,
          AGENT_BUNDLE_REGISTRY: join(state, "registry.json"),
        },
      });
      const response = JSON.parse(installed.stdout) as Record<string, unknown>;
      const codingAgentDir = join(resolve(home), "agent");
      expect(response["coding-agent-dir"]).toBe(codingAgentDir);
      expect(response).not.toHaveProperty("codingAgentDir");
      expect(parseInstalledBundle(response)).toMatchObject({
        home: resolve(home),
        profile: "pi",
        harness: { name: "pi", actualVersion: "0.1.0" },
        codingAgentDir,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes the core package in the DSH runtime installation", async () => {
    const signal = AbortSignal.timeout(20_000);
    const installation = await dshRuntimeInstallation(signal);
    expect(installation.files.map(file => file.target)).toContain("agentbundle/run.mjs");
    expect(installation.files.map(file => file.target)).toContain("dsh-output-hook.mjs");
    expect(installation.files.map(file => file.target)).not.toContain("agentbundle/cli.mjs");
    const inventory = await runtimeInventory(installation, process.platform, signal);
    const root = await mkdtemp(join(tmpdir(), "agentbundle-dsh-runtime-test-"));
    try {
      await copyRuntimeInventory(inventory, root, signal);
      const { stdout } = await execFileAsync(process.execPath, [join(root, "agentbundle", "run.mjs"), "--version"]);
      expect(stdout.trim()).toBe(AGENT_BUNDLE_CORE_VERSION);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
