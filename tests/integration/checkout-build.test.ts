import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "evaluator-checkout-build-")); roots.push(root);
  for (const dir of ["src", "scripts", "dist", "bin", "src/infrastructure/ray/python", "src/application/ray/entries", "src/plugins/verifiers/python/runtime", "src/runtimes/pi", "src/runtimes/dsh/assets", "src/runtimes/deepagents/assets", "src/runtimes/dify/assets", "src/runtimes/jiuwenswarm/assets", "src/runtimes/agentbundle/assets", "src/plugins/benchmarks/agent-harness/profiles", "src/plugins/benchmarks/inference-engine/profiles", "src/plugins/benchmarks/operator/profiles"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: { "": {} } }));
  await cp(new URL("../../src/plugins/benchmarks/agent-harness/definitions/scoring/", import.meta.url), join(root, "src/plugins/benchmarks/agent-harness/definitions/scoring"), { recursive: true });
  await cp(new URL("../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime/", import.meta.url), join(root, "src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime"), { recursive: true });
  await mkdir(join(root, "src/plugins/benchmarks/operator/kernel/runtime"), { recursive: true });
  for (const name of ["precision.py", "timing.py", "msprof_replay.py", "strict.py", "timing_evidence.py"])
    await writeFile(join(root, "src/plugins/benchmarks/operator/kernel/runtime", name), "# packaged worker fixture\n");
  await writeFile(join(root, "src/cli.ts"), "fixture");
  await writeFile(join(root, "src/plugins/benchmarks/agent-harness/profiles/fixture.yaml"), "id: fixture\n");
  await writeFile(join(root, "src/runtimes/dify/assets/runner.mjs"), "export {};\n");
  await writeFile(join(root, "src/runtimes/pi/model-defaults.json"), "{}\n");
  await mkdir(join(root, "src/runtimes/agentx/assets"), { recursive: true });
  await writeFile(join(root, "src/runtimes/agentx/assets/runner.py"), "# AgentX bridge fixture\n");
  await mkdir(join(root, "src/runtimes/hermes/assets"), { recursive: true });
  await writeFile(join(root, "src/runtimes/hermes/assets/runner.py"), "# Hermes output capture fixture\n");
  for (const name of ["worker.py", "workbuddy.py", "Dockerfile", "build-runtime.py"]) await writeFile(join(root, "src/plugins/verifiers/python/runtime", name), "fixture\n");
  await writeFile(join(root, "src/runtimes/agentbundle/assets/run.mjs"), "export {};\n");
  for (const name of ["jobs-entry", "jobs-gateway", "jobs-retry-entry"]) await writeFile(join(root, `src/application/ray/entries/${name}.mjs`), "export {};\n");
  for (const name of ["cli-bootstrap.mjs", "package-runtime.mjs"]) await cp(new URL(`../../scripts/${name}`, import.meta.url), join(root, `scripts/${name}`));
  await cp(new URL("../../scripts/checkout-build.mjs", import.meta.url), join(root, "scripts/checkout-build.mjs")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await cp(join(root, "scripts/cli-bootstrap.mjs"), join(root, "dist/cli.js"));
  await writeFile(join(root, "scripts/source-fingerprint.mjs"), 'export async function sourceFingerprint() { return "new"; }\n');
  await writeFile(join(root, "dist/source-provenance.json"), '{"digest":"old"}');
  await writeFile(join(root, "bin/pnpm"), `#!${process.execPath}
import { mkdir, writeFile, readFile, appendFile, open } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
if (process.argv[2] === "build") {
  await appendFile("builds.log", "build\\n");
  if (process.env.FIXTURE_BUILD_FAIL) process.exit(7);
  await mkdir("dist/runtimes/pi", { recursive: true });
  await mkdir("dist/core/errors", { recursive: true });
  await mkdir("dist/infrastructure/network", { recursive: true });
  await mkdir("dist/core/progress", { recursive: true });
  await mkdir("dist/plugins/benchmarks/agent-harness/definitions/scoring", { recursive: true });
  await writeFile("dist/infrastructure/network/env-proxy.js", "export {};\\n");
  for (const name of ["classify", "network-failure", "evaluator-error", "registry"])
    await writeFile("dist/core/errors/" + name + ".js", "export {};\\n");
  await writeFile("dist/core/errors/diagnostics.js", "export {};\\n");
  await writeFile("dist/core/progress/live-progress.js", "export {};\\n");
  await writeFile("dist/cli.js", 'export async function runCli() { console.log("fixture-run-ok"); return 0; }\\n');
  // Leave both real launchers time to enter the rebuild before packaging.
  let first = true;
  try { const file = await open("first-build", "wx"); await file.close(); } catch (error) { if (error.code !== "EEXIST") throw error; first = false; }
  await setTimeout(first ? 200 : 450);
  await import("../scripts/package-runtime.mjs");
}
`, { mode: 0o755 });
  return root;
}

function launch(root: string, env: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "dist/cli.js"), "run", "fixture.yaml"], { cwd: root, env: { ...process.env, ...env, PATH: join(root, "bin") + delimiter + process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += String(data); });
    child.stderr.on("data", data => { output += String(data); });
    child.on("error", reject); child.on("close", code => { resolve({ code, output }); });
  });
}

test.skipIf(process.platform === "win32")("concurrent stale-checkout CLI starts build once and both load the compiled runtime", async () => {
  const root = await fixture();
  const results = await Promise.all([launch(root), launch(root)]);
  expect(results, JSON.stringify(results)).toEqual(results.map(() => ({ code: 0, output: expect.stringContaining("fixture-run-ok") })));
  expect((await readFile(join(root, "builds.log"), "utf8")).trim().split("\n")).toHaveLength(1);
  expect(await readFile(join(root, "dist/cli-runtime.js"), "utf8")).not.toContain('await import("./cli-runtime.js")');
  expect(await readFile(join(root, "dist/plugins/benchmarks/agent-harness/profiles/fixture.yaml"), "utf8")).toBe("id: fixture\n");
  expect(await readFile(join(root, "dist/runtimes/dify/assets/runner.mjs"), "utf8")).toBe("export {};\n");
  expect(await readFile(join(root, "dist/runtimes/agentx/assets/runner.py"), "utf8")).toBe("# AgentX bridge fixture\n");
  expect(await readFile(join(root, "dist/runtimes/hermes/assets/runner.py"), "utf8")).toBe("# Hermes output capture fixture\n");
  expect((await launch(root)).code).toBe(0);
  expect((await readFile(join(root, "builds.log"), "utf8")).trim().split("\n")).toHaveLength(1);
});

test.skipIf(process.platform === "win32")("failed checkout build releases ownership so a later CLI can rebuild", async () => {
  const root = await fixture();
  expect((await launch(root, { FIXTURE_BUILD_FAIL: "1" })).code).not.toBe(0);
  expect(await launch(root)).toMatchObject({ code: 0, output: expect.stringContaining("fixture-run-ok") });
});

test.skipIf(process.platform === "win32")("abandoned build ownership times out without deleting another owner's evidence", async () => {
  const root = await fixture();
  await mkdir(join(root, ".evaluator-build.lock"));
  await writeFile(join(root, ".evaluator-build.lock/owner.json"), '{"pid":1}');
  const script = `import { ensureCheckoutBuild } from "./scripts/checkout-build.mjs"; await ensureCheckoutBuild(process.cwd(), () => { throw new Error("must not build"); }, { timeoutMs: 25 });`;
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", data => { stderr += String(data); });
    child.on("error", reject); child.on("close", code => { resolve({ code, stderr }); });
  });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Timed out waiting for checkout build lock");
  expect(await readFile(join(root, ".evaluator-build.lock/owner.json"), "utf8")).toBe('{"pid":1}');
});
