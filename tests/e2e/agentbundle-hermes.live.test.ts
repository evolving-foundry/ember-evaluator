import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";
import { validateSequence, type TrajectoryEvent } from "../../src/core/artifacts/trajectory.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";

const bundlePath = process.env.HERMES_BUNDLE_PATH ?? resolve("tests/fixtures/agentbundle/hermes");

test("live local hermes bundle installs once and answers through the mock model", async () => {
  const root = resolve(".scratch/agentbundle-hermes-live");
  const cache = join(root, "cache");
  const workspaces = join(root, "workspaces");
  await Promise.all([mkdir(cache, { recursive: true }), mkdir(workspaces, { recursive: true })]);
  const run = await mkdtemp(join(root, "run-"));
  const model = spawn(process.execPath, [resolve("tests/fixtures/hermes-model-server.mjs")], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  model.stderr.on("data", bytes => { stderr += String(bytes); });
  let stdout = "";
  const port = await new Promise<number>((resolvePort, reject) => {
    const output = (bytes: Buffer) => {
      stdout += bytes.toString("utf8");
      const line = stdout.split(String.fromCharCode(10))[0];
      if (!line) return;
      model.stdout.off("data", output);
      try { resolvePort((JSON.parse(line) as { port: number }).port); }
      catch (error) { reject(error); }
    };
    model.stdout.on("data", output);
    model.once("error", reject);
    model.once("exit", code => reject(new Error(`mock model exited ${code}: ${stderr}`)));
  });

  const solver = new AgentBundleSolver(bundlePath, {
    name: "office-mock-model",
    endpoint: `http://127.0.0.1:${port}/v1`,
    provider: null,
    api: "openai-completions",
  }, { value: "hermes-smoke-secret", reference: null });
  const signal = AbortSignal.timeout(1_800_000);
  const sessions = new Set<EnvironmentSession>();
  try {
    const provenance = await solver.provenance(signal);
    expect(provenance.harness).toBe("hermes");
    const installation = await solver.runtimeInstallation(signal);
    expect(installation.id.startsWith("hermes:")).toBe(true);
    const environment = new LocalEnvironment(workspaces, cache);
    const attempt = join(run, "attempt-1");
    const paths = { root: attempt, agent: join(attempt, "agent"), verifier: join(attempt, "verifier"), artifacts: join(attempt, "artifacts") };
    await mkdir(paths.agent, { recursive: true });
    const context = { key: { runId: "agentbundle-hermes-live", taskId: "task-1", attemptId: "attempt-1" }, paths, signal };
    const session = await environment.prepare({ workdir: ".", image: null, initialFiles: [], runtime: solver.requirements(), installation }, paths, "solve", signal);
    sessions.add(session);
    const prepared = await solver.prepare(session, context);
    try {
      const result = await prepared.solve({ id: "task-1", prompt: "what is 6*7? answer with just the number" }, context);
      expect(result.finalText).toContain("Answer: 42");
      expect(result.usage).toBeDefined();
      const trajectoryText = await readFile(join(paths.agent, "trajectory.jsonl"), "utf8");
      const trajectory = trajectoryText.trimEnd().split(String.fromCharCode(10)).filter(Boolean).map(line => JSON.parse(line) as TrajectoryEvent);
      expect(validateSequence(trajectory)).toEqual({ complete: true, missing: [] });
      expect(trajectory.map(event => event.type)).toEqual(["start", "usage", "end"]);
      // The install wrote an installation.json and merged a hermes config.yaml.
      const installationJson = JSON.parse(await readFile(join(paths.agent, "installation.json"), "utf8")) as { profile: string; reused: boolean };
      // The install record profile is the bundle manifest name (no explicit --profile is passed).
      const bundleManifest = await readFile(join(bundlePath, "bundle.yaml"), "utf8");
      expect(installationJson.profile).toBe(/^name:\s*(\S+)/m.exec(bundleManifest)?.[1]);
      expect(installationJson.reused).toBe(false);
    } finally {
      await prepared.dispose?.(AbortSignal.timeout(5000));
      await session.dispose(AbortSignal.timeout(5000));
      sessions.delete(session);
    }
  } finally {
    await Promise.all([...sessions].map(session => session.dispose(AbortSignal.timeout(5000)).catch(() => {})));
    if (model.exitCode === null && model.signalCode === null) {
      const exited = new Promise<void>(resolveExit => model.once("exit", () => resolveExit()));
      model.kill();
      await exited;
    }
    await rm(run, { recursive: true, force: true });
  }
}, 1_800_000);
