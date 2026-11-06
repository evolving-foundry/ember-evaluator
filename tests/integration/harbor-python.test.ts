import type { SpawnOptions } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { preparePythonVerifier } from "../../src/plugins/verifiers/python/runtime/bridge.js";
import type { VerificationTask } from "../../src/core/contracts/verifier.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";
import type { PluginFactoryContext } from "../../src/core/contracts/plugin.js";
import { HarborPythonVerifier, parsePythonVerifierConfig } from "../../src/plugins/verifiers/python/index.js";
import { VerificationError } from "../../src/core/errors/verification-error.js";

const fixtureWorker = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(1);
const mounts = args.flatMap((value, index) => value === "--mount" ? [args[index + 1]] : []);
const trial = mounts.find(value => value.endsWith("target=/trial")).slice("type=bind,source=".length).split(",target=")[0];
const lines = readline.createInterface({ input: process.stdin });
let request;
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
lines.on("line", line => {
  const value = JSON.parse(line);
  if (!request) {
    request = value;
    if (["fixture:JudgeError", "fixture:BuildError", "fixture:Crash", "fixture:StallEvidence"].includes(request.importPath)) {
      const status = request.importPath === "fixture:BuildError" ? "build_error" : "judge_error";
      fs.writeFileSync(trial + "/verifier/score.json", JSON.stringify({ test_status: status, error: "native scoring cause", credential: request.env.KEY }));
      fs.writeFileSync(trial + "/verifier/test_output.txt", "native scoring cause " + (request.env.KEY || ""));
      process.stderr.write("worker stderr detail " + (request.env.KEY || ""), () => {
        if (request.importPath === "fixture:StallEvidence") return;
        if (request.importPath === "fixture:Crash") { process.exit(1); return; }
        send({ type: "error", message: "Upstream verifier reported " + status,
          details: { score: { test_status: status, error: "native scoring cause", credential: request.env.KEY } } });
      });
      return;
    }
    if (request.importPath === "fixture:Stall") return;
    send({ type: "call", id: 1, operation: "exec", command: "grade", cwd: "/workspace", env: request.env, timeout: 2 });
  } else if (value.error) { send({ type: "error", message: value.error }); process.exit(1); }
  else if (value.id === 1) send({ type: "call", id: 2, operation: "upload_dir", source: "/dataset/tests", target: "/tests" });
  else if (value.id === 2) send({ type: "call", id: 3, operation: "upload_file", data: Buffer.from("temporary private verifier").toString("base64"), target: "/tests/generated.py" });
  else if (value.id === 3) send({ type: "call", id: 4, operation: "download_dir", source: "/logs/verifier", target: "/trial/verifier" });
  else {
    const details = { judge_endpoint: request.env.ENDPOINT, diagnostic: request.env.KEY };
    fs.writeFileSync(trial + "/verifier/score.json", JSON.stringify(details));
    send({ type: "result", rewards: { reward: 0.75, f2p: 1 }, details });
    process.exit(0);
  }
});
`;

const dockerState = vi.hoisted(() => ({ containers: new Map<string, string[]>(), calls: [] as string[][] }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (executable: string, args: string[], options: SpawnOptions) => {
    if (executable !== "fixture-verifier") return actual.spawn(executable, args, options);
    dockerState.calls.push(args);
    if (args[0] === "create") dockerState.containers.set(args[args.indexOf("--name") + 1]!, args);
    if (args[0] === "start") return actual.spawn(process.execPath, ["-e", fixtureWorker, ...dockerState.containers.get(args.at(-1)!)!], options);
    if (args[0] === "rm") dockerState.containers.delete(args.at(-1)!);
    const output = args[0] === "image" ? "sha256:" + "a".repeat(64) : args[0] === "container"
      ? JSON.stringify({ Status: "exited", ExitCode: 0, Error: "", StartedAt: "2026-10-24T00:00:00Z" }) : "created";
    return actual.spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)})`], options);
  } };
});
const roots: string[] = [];
afterEach(async () => {
  expect(dockerState.containers.size).toBe(0);
  dockerState.calls.length = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const solved = { finalText: "", usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
const key = { runId: "run", taskId: "task", attemptId: "attempt" };
async function runPythonVerifier(task: VerificationTask, session: EnvironmentSession, importPath: string,
  env: Record<string, string>, docker: string, signal: AbortSignal, secrets: readonly string[] = [], _image?: string) {
  const handle = await preparePythonVerifier(task, importPath, env, docker, "sha256:" + "a".repeat(64), key, signal, secrets);
  try { return await handle.verify(solved, session, signal); }
  finally { await handle.dispose(AbortSignal.timeout(5000)); }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harbor-python-")); roots.push(root);
  const dataset = join(root, "dataset"); const output = join(root, "verifier");
  await mkdir(join(dataset, "tests"), { recursive: true }); await mkdir(output);
  const operations: string[] = []; const variables: Record<string, string>[] = [];
  const session: EnvironmentSession = { id: "verify", workdir: "/workspace", agentOutputDir: root, verifierOutputDir: output, metadata: { phase: "verify" },
    async start(command) { operations.push("exec"); variables.push(command.env); return { stdout: (async function* () { yield Buffer.from("graded"); })(), stderr: (async function* () {})(), done: Promise.resolve({ code: 0, signal: null }), async stop() {} }; },
    async upload(source, target) { operations.push(target); if (target.endsWith("generated.py")) expect(await readFile(source, "utf8")).toBe("temporary private verifier");
      if (target === session.verifierOutputDir) await cp(source, output, { recursive: true }); },
    async download(_source, target) { operations.push("download"); await writeFile(join(target, "test-stdout.txt"), "fixture-judge-secret"); },
    async exportState() { throw new Error("unused"); }, async restoreState() {}, async dispose() {} };
  return { root, output, task: { id: "fixture", taskDir: dataset, datasetDir: dataset, workdir: "/workspace", timeoutSeconds: 5 }, session, operations, variables };
}

test("Python bridge proxies verifier operations and redacts judge credentials from evidence", async () => {
  const value = await fixture();
  const evidence = await runPythonVerifier(value.task, value.session, "fixture:Verifier", { ENDPOINT: "http://127.0.0.1:1234/v1", KEY: "fixture-judge-secret" }, "fixture-verifier", AbortSignal.timeout(5000), ["fixture-judge-secret"], "fixture@sha256:" + "a".repeat(64));
  expect(evidence.rewards).toEqual({ reward: 0.75, f2p: 1 });
  expect(evidence.details).toMatchObject({ judge_endpoint: "http://host.docker.internal:1234/v1" });
  expect(JSON.stringify(evidence)).not.toContain("fixture-judge-secret");
  expect(value.operations).toEqual(["exec", "/tests", "/tests/generated.py", "download", value.session.verifierOutputDir]);
  expect(value.variables[0]?.KEY).toBe("fixture-judge-secret");
  expect(await readFile(join(value.session.verifierOutputDir, "score.json"), "utf8")).not.toContain("fixture-judge-secret");
  expect(await readFile(join(value.session.verifierOutputDir, "test-stdout.txt"), "utf8")).not.toContain("fixture-judge-secret");
});

test("Python verifier accepts an omitted phase ceiling and follows the caller signal", async () => {
  const value = await fixture();
  const { timeoutSeconds: _timeout, ...task } = value.task;
  const evidence = await runPythonVerifier(task, value.session, "fixture:Verifier", {}, "fixture-verifier", AbortSignal.timeout(5000), [], "fixture@sha256:" + "a".repeat(64));
  expect(evidence.rewards.reward).toBe(0.75);
});

test("Python evidence is uploaded to an environment path rather than copied to a host absolute path", async () => {
  const value = await fixture();
  value.session.verifierOutputDir = "/logs/verifier";
  await runPythonVerifier(value.task, value.session, "fixture:Verifier", {}, "fixture-verifier", AbortSignal.timeout(5000), [], "fixture@sha256:" + "a".repeat(64));
  expect(value.operations.at(-1)).toBe("/logs/verifier");
  expect(JSON.parse(await readFile(join(value.output, "score.json"), "utf8"))).toEqual({});
});

test.each([false, true])("Python verifier injects a model route only with an explicit service binding: %s", async enabled => {
  const value = await fixture();
  const binding = {
    model: { name: "solver-model", endpoint: "https://model.invalid/v1", provider: null, api: null },
    auth: { value: "solver-secret", reference: "MODEL_API_KEY" },
  };
  const runtime: PluginFactoryContext = {
    services: { default: binding }, solverService: "default", configDirectory: value.root,
    resolvePath: path => join(value.root, path), ...(enabled ? { verifierService: "default" } : {}),
  };
  const verifier = new HarborPythonVerifier(parsePythonVerifierConfig({
    dockerExecutable: "fixture-verifier", runtimeImage: "fixture@sha256:" + "a".repeat(64),
    requireService: enabled,
  }), runtime);
  const descriptor = { descriptor: value.task, env: { TASK_SETTING: "retained" } };
  const signal = AbortSignal.timeout(5000);
  const receipt = await verifier.runtime.materialize(descriptor, signal);
  expect(dockerState.calls.every(args => args[0] === "image")).toBe(true);
  const handle = await verifier.runtime.prepare(descriptor, receipt, { key, signal,
    paths: { root: value.root, agent: value.root, verifier: value.output, artifacts: value.root } });
  try { await handle.verify(solved, value.session, signal); }
  finally { await handle.dispose(AbortSignal.timeout(5000)); }
  expect(value.variables[0]).toEqual(enabled ? {
    TASK_SETTING: "retained", WORKBUDDY_VERIFIER_LLM_BASE_URL: "https://model.invalid/v1",
    WORKBUDDY_VERIFIER_LLM_API_KEY: "solver-secret", WORKBUDDY_VERIFIER_LLM_MODEL: "solver-model",
  } : { TASK_SETTING: "retained" });
});

test("cancelling a Python verifier stops a stalled worker", async () => {
  const value = await fixture(); const cancel = new AbortController();
  const run = runPythonVerifier(value.task, value.session, "fixture:Stall", {}, "fixture-verifier", cancel.signal, [], "fixture@sha256:" + "a".repeat(64));
  setTimeout(() => cancel.abort(new Error("fixture cancellation")), 100);
  await expect(run).rejects.toThrow("fixture cancellation");
});

test.each(["JudgeError", "BuildError", "Crash"])("Python %s preserves redacted native evidence before disposal", async kind => {
  const value = await fixture();
  let failure: unknown;
  try {
    await runPythonVerifier(value.task, value.session, `fixture:${kind}`, { KEY: "fixture-judge-secret" },
      "fixture-verifier", AbortSignal.timeout(10000), ["fixture-judge-secret"]);
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(VerificationError);
  expect(failure).toMatchObject({ code: "VERIFY_EXEC_FAILED" });
  expect(String(failure)).toContain("worker stderr detail");
  expect(String(failure)).not.toContain("fixture-judge-secret");
  const score = await readFile(join(value.output, "score.json"), "utf8");
  expect(score).toContain("native scoring cause");
  expect(score).not.toContain("fixture-judge-secret");
  const diagnostics = await readFile(join(value.output, "evaluator-worker.json"), "utf8");
  expect(diagnostics).toContain("worker stderr detail");
  expect(diagnostics).not.toContain("fixture-judge-secret");
  const create = dockerState.calls.find(args => args[0] === "create")!;
  const mount = create.find(arg => arg.endsWith("target=/trial"))!;
  const trial = mount.slice("type=bind,source=".length).split(",target=")[0]!;
  await expect(readFile(join(trial, "verifier/score.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("Python verifier timeout uses an independent signal to archive partial evidence", async () => {
  const value = await fixture();
  await expect(runPythonVerifier({ ...value.task, timeoutSeconds: 0.5 }, value.session, "fixture:StallEvidence", {},
    "fixture-verifier", AbortSignal.timeout(10000))).rejects.toBeInstanceOf(VerificationError);
  expect(await readFile(join(value.output, "test_output.txt"), "utf8")).toContain("native scoring cause");
});

test("archive failure retains the original native error and records the secondary failure", async () => {
  const value = await fixture();
  value.session.upload = async (_source, _target, signal) => {
    expect(signal.aborted).toBe(false);
    throw new Error("fixture archive failed");
  };
  const run = runPythonVerifier(value.task, value.session, "fixture:JudgeError", {}, "fixture-verifier", AbortSignal.timeout(10000));
  await expect(run).rejects.toMatchObject({ message: expect.stringContaining("Upstream verifier reported judge_error"),
    evidence: { archiveError: expect.stringContaining("fixture archive failed") } });
});

test("concurrent cleanup waits for cancelled verification to finish archiving", async () => {
  const value = await fixture();
  const uploading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const upload = value.session.upload.bind(value.session);
  value.session.upload = async (...args) => { uploading.resolve(); await release.promise; await upload(...args); };
  const handle = await preparePythonVerifier({ ...value.task, timeoutSeconds: 0.5 }, "fixture:StallEvidence", {},
    "fixture-verifier", "sha256:" + "a".repeat(64), key, AbortSignal.timeout(10000));
  const verification = expect(handle.verify(solved, value.session, AbortSignal.timeout(10000))).rejects.toBeInstanceOf(VerificationError);
  await uploading.promise;
  const disposing = handle.dispose(AbortSignal.timeout(5000));
  release.resolve();
  await verification;
  await disposing;
  expect(await readFile(join(value.output, "score.json"), "utf8")).toContain("judge_error");
});
