import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, mkdir, rm, cp } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import type { AttemptContext, AttemptKey, AttemptPaths, ComponentActivity, EnvironmentSession, ProcessHandle, PublicTask, RuntimeInstallation } from "../../src/index.js";
import { packageManagerCli } from "../../src/infrastructure/network/package-manager.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { parseRunnerInput, projectRunnerInput } from "../../src/runtimes/pi/protocol.js";
import { run } from "../../src/runtimes/pi/runner.js";
import { TrajectoryWriter, validateSequence, type TrajectoryEvent } from "../../src/core/artifacts/trajectory.js";
import { SimpleAgentSolver } from "../../src/plugins/solvers/simpleagent.js";
import { loadConfig } from "../../src/application/config.js";
import { loadBuiltinRuntimeDigest } from "../../src/infrastructure/provenance/builtin-runtime.js";
import { taskMcpServer } from "../fixtures/task-mcp-server.js";

const fixtureRoot = resolve("tests/fixtures");
let root: string;
let statePath: string;
let server: ChildProcess;
let endpoint: string;

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  let buffered = "";
  for await (const part of stream) {
    buffered += Buffer.from(part as Uint8Array).toString("utf8");
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return buffered.slice(0, newline);
  }
  throw new Error("model server exited before reporting its port");
}

async function paths(name: string): Promise<AttemptPaths> {
  const base = join(root, name);
  const result = {
    root: base,
    agent: join(base, "agent"),
    verifier: join(base, "verifier"),
    artifacts: join(base, "artifacts"),
  };
  await Promise.all(Object.values(result).map(path => mkdir(path, { recursive: true })));
  return result;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await stat(path).then(value => value.size > 0, () => false)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForText(path: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await readFile(path, "utf8").then(value => value.includes(expected), () => false)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${expected} in ${path}`);
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value, "utf8");
}

function fakeSession(rootPath: string, stdout: string): EnvironmentSession {
  const processHandle: ProcessHandle = {
    stdout: chunks(stdout),
    stderr: chunks(""),
    done: Promise.resolve({ code: 0, signal: null }),
    async stop() {},
  };
  return {
    id: "fake",
    workdir: rootPath,
    agentOutputDir: rootPath,
    verifierOutputDir: rootPath,
    metadata: { kind: "local" },
    runtime: { root: rootPath, persistent: true, identity: "fixture-runtime" },
    async start() { return processHandle; },
    async upload() {},
    async download() {},
    async exportState() { throw new Error("unused"); },
    async restoreState() {},
    async dispose() {},
  };
}

function remoteSession(
  commands: Parameters<EnvironmentSession["start"]>[0][],
  uploads: string[],
  prepared = true,
): EnvironmentSession {
  return {
    id: "remote",
    workdir: "/workspace",
    agentOutputDir: "/output/agent",
    verifierOutputDir: "/output/verifier",
    metadata: { kind: "docker" },
    ...(prepared ? { runtime: { root: "/opt/evaluator-agent", persistent: false, identity: "fixture-runtime" } } : {}),
    async start(command) {
      commands.push(command);
      return {
        stdout: chunks(`${JSON.stringify({ schemaVersion: 1, type: "result", result: { finalText: "done", usage: { inputTokens: null, outputTokens: null, totalTokens: null } } })}\n`),
        stderr: chunks(""),
        done: Promise.resolve({ code: 0, signal: null }),
        async stop() {},
      };
    },
    async upload(_source, target) { uploads.push(target); },
    async download() {},
    async exportState() { throw new Error("unused"); },
    async restoreState() {},
    async dispose() {},
  };
}

async function prepareSimpleAgent(
  environment: LocalEnvironment,
  solver: SimpleAgentSolver,
  attemptPaths: AttemptPaths,
  context: AttemptContext,
  initialFiles: { source: string; target: string }[] = [],
) {
  const installation = await portableInstallation(solver, context.signal);
  const session = await environment.prepare({
    workdir: ".",
    image: null,
    initialFiles,
    runtime: solver.requirements(),
    installation,
  }, attemptPaths, "solve", context.signal);
  const prepared = await solver.prepare!(session, context);
  return { session, prepared };
}

async function portableInstallation(solver: SimpleAgentSolver, signal: AbortSignal): Promise<RuntimeInstallation> {
  const installation = { ...await solver.runtimeInstallation(signal) };
  // Exercise the packaged runtime on the host filesystem. Loading the source
  // checkout through WSL's Windows mount can consume the whole solve timeout.
  delete installation.localRoot;
  return installation;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "simpleagent-test-"));
  statePath = join(root, "requests.jsonl");
  server = spawn(process.execPath, [join(fixtureRoot, "model-server.mjs"), statePath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const startup = JSON.parse(await firstLine(server.stdout!)) as { port: number };
  endpoint = `http://127.0.0.1:${startup.port}/v1`;
  // Dependency installation is suite setup; attempts retain their original
  // execution/cancellation budgets and still run the real isolated Pi runner.
  const solver = new SimpleAgentSolver(
    { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
    { value: "fixture-setup-key", reference: null },
  );
  const signal = AbortSignal.timeout(180_000);
  await new LocalEnvironment().installRuntime(await portableInstallation(solver, signal), signal);
}, 240_000);

afterAll(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), new Promise(resolveWait => setTimeout(resolveWait, 2_000))]);
  }
  if (root) await rm(root, { recursive: true, force: true });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe("simpleagent runner", () => {
  test.skipIf(process.platform === "win32")("honors the explicit Bash path before starting a model session", async () => {
    vi.stubEnv("EMBER_BASH_PATH", join(root, "missing-shell"));
    try {
      await expect(run(projectRunnerInput({
        key: { runId: "run", taskId: "shell", attemptId: "attempt" },
        input: { id: "shell", prompt: "unused" },
        model: { name: "fixture", endpoint, provider: null, api: "openai-completions" },
        auth: { value: "fixture", reference: null },
        workdir: root,
        outputDir: join(root, "invalid-shell"),
      }))).rejects.toThrow(/EMBER_BASH_PATH/u);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("projects only public task fields into runner stdin", () => {
    const input = { id: "task", prompt: "public", verification: { answer: "private" } };
    const projected = projectRunnerInput({
      key: { runId: "run", taskId: "task", attemptId: "attempt" },
      input,
      model: { name: "fixture", endpoint, provider: null, api: "openai-completions" },
      auth: { value: "secret", reference: "MODEL_KEY" },
      workdir: "/work",
      outputDir: "/output",
    });
    expect(projected.input).toEqual({ id: "task", prompt: "public" });
    expect(JSON.stringify(projected)).not.toContain("private");
  });

  test("projects and validates the model retry budget", () => {
    const base = {
      key: { runId: "run", taskId: "task", attemptId: "attempt" },
      input: { id: "task", prompt: "public" },
      auth: { value: "secret", reference: null },
      workdir: "/work",
      outputDir: "/output",
    };
    const projected = projectRunnerInput({
      ...base,
      model: { name: "fixture", endpoint, provider: null, api: "openai-completions", retry: { maxAttempts: 2 } },
    });
    expect(projected.model.retry).toEqual({ maxAttempts: 2 });
    const plain = projectRunnerInput({ ...base, model: { name: "fixture", endpoint, provider: null, api: "openai-completions" } });
    expect(plain.model.retry).toBeUndefined();
    expect(parseRunnerInput(plain).model.retry).toBeUndefined();
    expect(parseRunnerInput(projected).model.retry).toEqual({ maxAttempts: 2 });
    expect(() => parseRunnerInput({ ...projected, model: { ...projected.model, retry: { maxAttempts: 0 } } })).toThrow(/maxAttempts/);
    expect(() => parseRunnerInput({ ...projected, model: { ...projected.model, retry: { backoff: "exponential" } } })).toThrow(/unknown field/);
  });

  test("projects and validates the shell tool policy", () => {
    const base = {
      key: { runId: "run", taskId: "task", attemptId: "attempt" },
      input: { id: "task", prompt: "public" },
      model: { name: "fixture", endpoint, provider: null, api: "openai-completions" },
      auth: { value: "secret", reference: null },
      workdir: "/work",
      outputDir: "/output",
    };
    const plain = projectRunnerInput(base);
    expect(plain.toolPolicy).toBeUndefined();
    expect(parseRunnerInput(plain).toolPolicy).toBeUndefined();

    const projected = projectRunnerInput({
      ...base,
      toolPolicy: { shellTimeoutSeconds: 120, shellMaxTimeoutSeconds: 300 },
      piConfigDir: "/opt/evaluator-agent/pi-config",
      piSettings: { office: { enabled: true, readOnly: false } },
    });
    expect(parseRunnerInput(projected)).toMatchObject({
      toolPolicy: { shellTimeoutSeconds: 120, shellMaxTimeoutSeconds: 300 },
      piConfigDir: "/opt/evaluator-agent/pi-config",
      piSettings: { office: { enabled: true, readOnly: false } },
    });
    expect(() =>
      parseRunnerInput({ ...projected, toolPolicy: { shellTimeoutSeconds: 0, shellMaxTimeoutSeconds: 300 } }),
    ).toThrow(/shellTimeoutSeconds/);
    expect(() =>
      parseRunnerInput({ ...projected, toolPolicy: { shellTimeoutSeconds: 120, shellMaxTimeoutSeconds: 90 } }),
    ).toThrow(/shellMaxTimeoutSeconds/);
    expect(() =>
      parseRunnerInput({ ...projected, toolPolicy: { shellTimeoutSeconds: 120, shellMaxTimeoutSeconds: 300, extra: true } }),
    ).toThrow(/unknown field/);
  });

  test("runs isolated concurrent sessions through the Environment boundary", async () => {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      vi.stubEnv("PATH", [dirname(process.execPath), join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";"));
      vi.stubEnv("EMBER_BASH_PATH", join(root, "no-git-bash"));
    }
    const workspaceRoot = join(root, "workspaces");
    await mkdir(workspaceRoot, { recursive: true });
    const environment = new LocalEnvironment(workspaceRoot);
    const model = { name: "fixture-model", endpoint, provider: null, api: "openai-completions" };
    const cases = [
      { name: "alpha", key: "key-alpha" },
      { name: "beta", key: "key-beta" },
    ];

    const running = await Promise.all(cases.map(async ({ name, key }) => {
      const attemptPaths = await paths(name);
      const attemptKey: AttemptKey = { runId: "run", taskId: name, attemptId: "attempt-1" };
      const solver = new SimpleAgentSolver(model, { value: key, reference: null });
      const activities: ComponentActivity[] = [];
      const context = { key: attemptKey, paths: attemptPaths, signal: new AbortController().signal,
        activity: (event: ComponentActivity) => { activities.push(event); } };
      const { session, prepared } = await prepareSimpleAgent(environment, solver, attemptPaths, context, [
          { source: join(fixtureRoot, "pi-isolation", "AGENTS.md"), target: "AGENTS.md" },
          { source: join(fixtureRoot, "pi-isolation", ".pi", "extensions", "evil.js"), target: ".pi/extensions/evil.js" },
      ]);
      const input: PublicTask = { id: name, prompt: `complete ${name}` };
      const promise = prepared.solve(input, context);
      return { name, key, attemptKey, attemptPaths, session, promise, activities };
    }));

    await Promise.all(running.map(item => waitForFile(join(item.attemptPaths.agent, "trajectory.jsonl"))));
    const results = await Promise.all(running.map(item => item.promise));

    expect(results).toEqual([
      { finalText: "Answer: alpha", usage: { inputTokens: 24, outputTokens: 12, totalTokens: 36 } },
      { finalText: "Answer: beta", usage: { inputTokens: 24, outputTokens: 12, totalTokens: 36 } },
    ]);
    try {
      for (const item of running) {
        expect(item.activities.some(event => event.message?.includes("tool"))).toBe(true);
        expect(item.activities.some(event => event.message?.includes("model"))).toBe(true);
        expect(JSON.stringify(item.activities)).not.toContain(item.key);
        expect(JSON.stringify(item.activities)).not.toContain(`Answer: ${item.name}`);
        const trajectoryText = await readFile(join(item.attemptPaths.agent, "trajectory.jsonl"), "utf8");
        expect(trajectoryText.endsWith("\n")).toBe(true);
        const events = trajectoryText.trimEnd().split("\n").map(line => JSON.parse(line) as TrajectoryEvent);
        expect(validateSequence(events)).toEqual({ complete: true, missing: [] });
        expect(events.some(event => event.type === "tool_start" && JSON.stringify(event.data).includes("marker.txt"))).toBe(true);
        const nativeSession = await readFile(join(item.attemptPaths.agent, "session.jsonl"), "utf8");
        expect(nativeSession).toMatch(/"type":"session"/u);
        expect(nativeSession.endsWith("\n")).toBe(true);
        expect(nativeSession).not.toContain(item.key);
        expect(await readFile(join(item.session.workdir, "marker.txt"), "utf8")).toBe(item.name);
        expect(await stat(join(item.session.workdir, ".ember-runtime")).then(() => true, () => false)).toBe(false);
        expect(trajectoryText).not.toContain(item.key);
        expect(trajectoryText).not.toContain("ISOLATION_BREACH");
      }
    } finally {
      await Promise.all(running.map(item => item.session.dispose(new AbortController().signal)));
    }

    const requests = (await readFile(statePath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    for (const request of requests) {
      const tools = request.body.tools.map((tool: { function: { name: string } }) => tool.function.name);
      expect(tools).toContain(process.platform === "win32" ? "powershell" : "bash");
      expect(tools).not.toContain(process.platform === "win32" ? "bash" : "powershell");
    }
    expect(new Set(requests.map(request => request.authorization))).toEqual(new Set(["Bearer key-alpha", "Bearer key-beta"]));
    expect(requests.every(request => request.body.model === "fixture-model")).toBe(true);
    expect(requests.every(request => request.body.max_tokens === undefined && request.body.max_completion_tokens === undefined)).toBe(true);
    expect(requests.every(request => !JSON.stringify(request.body).includes("ISOLATION_BREACH"))).toBe(true);
    expect(requests.filter(request => request.authorization === "Bearer key-alpha").every(request => !JSON.stringify(request.body).includes("beta"))).toBe(true);
    expect(requests.filter(request => request.authorization === "Bearer key-beta").every(request => !JSON.stringify(request.body).includes("alpha"))).toBe(true);
  }, 30_000);

  test.each([
    { kind: "thinking", maxTokens: undefined, expected: 256 },
    { kind: "text", maxTokens: 32768, expected: 32768 },
  ])("returns provider or explicit truncated output with a warning for $kind", async ({ kind, maxTokens, expected }) => {
    const attemptPaths = await paths(`token-limit-${kind}`);
    const configPath = join(attemptPaths.root, "playbook.yaml");
    await writeFile(configPath, JSON.stringify({
      services: {
        default: { model: "fixture-model", base_url: endpoint, api: "openai-completions", api_key: "${LIMIT_KEY}", maxTokens },
      },
      benchmark: { name: "gsm8k", solver: { name: "simpleagent", service: "default" } },
      environment: { name: "local" },
      output: { directory: "./out" },
    }));
    const config = await loadConfig(configPath, {}, { LIMIT_KEY: "key-limit" });
    const solver = new SimpleAgentSolver(config.experiment.services.default!, config.auths.default!);
    const workspaceRoot = join(root, `limit-workspaces-${kind}`);
    await mkdir(workspaceRoot);
    const environment = new LocalEnvironment(workspaceRoot);
    const warnings: { code: string; message: string }[] = [];
    const context = { key: { runId: "run", taskId: kind, attemptId: "attempt" }, paths: attemptPaths,
      signal: new AbortController().signal, warning: (value: { code: string; message: string }) => warnings.push(value) };
    const { session, prepared } = await prepareSimpleAgent(environment, solver, attemptPaths, context);
    try {
      const result = await prepared.solve({ id: kind, prompt: `token-limit-${kind}` }, context);
      expect(result.finalText).toBe(kind === "thinking" ? "" : "Partial answer");
      expect(warnings).toContainEqual({
        code: "SOLVER_OUTPUT_LIMIT",
        message: expect.stringMatching(new RegExp(`stopReason=length.*model.maxTokens=${maxTokens ?? "provider-default"}.*outputTokens=${expected}`)),
      });
      const trajectory = (await readFile(join(attemptPaths.agent, "trajectory.jsonl"), "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as TrajectoryEvent);
      expect(validateSequence(trajectory)).toEqual({ complete: true, missing: [] });
      expect(trajectory.some(event => event.type === "warning")).toBe(true);
      expect(trajectory.some(event => event.type === "error")).toBe(false);
      const requests = (await readFile(statePath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
      const request = requests.at(-1);
      expect(request.body.max_tokens ?? request.body.max_completion_tokens).toBe(maxTokens);
      if (maxTokens === undefined) {
        expect(request.body).not.toHaveProperty("max_tokens");
        expect(request.body).not.toHaveProperty("max_completion_tokens");
      }
      expect(await readFile(join(attemptPaths.agent, "stderr.log"), "utf8")).toContain("SOLVER_OUTPUT_LIMIT");
    } finally {
      await session.dispose(new AbortController().signal);
    }
  }, 30_000);

  test.each(["token-limit-tool", "context-overflow"])("Harness handles %s without executing truncated tool arguments", async scenario => {
    const attemptPaths = await paths(scenario);
    const model = { name: "fixture-model", endpoint, provider: null, api: "openai-completions" };
    const solver = new SimpleAgentSolver(model, { value: `key-${scenario}`, reference: null });
    const workspace = join(root, `workspace-${scenario}`); await mkdir(workspace);
    const environment = new LocalEnvironment(workspace);
    const warnings: { code: string; message: string }[] = [];
    const context = { key: { runId: "run", taskId: scenario, attemptId: "a" }, paths: attemptPaths,
      signal: AbortSignal.timeout(25_000), warning: (item: { code: string; message: string }) => warnings.push(item) };
    const { session, prepared } = await prepareSimpleAgent(environment, solver, attemptPaths, context);
    try {
      const prompt = scenario === "context-overflow" ? `${scenario}\n${"task context ".repeat(12_000)}` : scenario;
      const result = await prepared.solve({ id: scenario, prompt }, context);
      expect(result.finalText).toBe("Answer: alpha");
      expect(await stat(join(session.workdir, "truncated-marker.txt")).then(() => true, () => false)).toBe(false);
      const native = await readFile(join(attemptPaths.agent, "session.jsonl"), "utf8");
      const requests = (await readFile(statePath, "utf8")).trim().split("\n").map(line => JSON.parse(line))
        .filter(item => item.authorization === `Bearer key-${scenario}`);
      if (scenario === "token-limit-tool") {
        expect(warnings).toEqual([expect.objectContaining({ code: "SOLVER_OUTPUT_LIMIT" })]);
        expect(requests).toHaveLength(2); // Ordinary next turn after failed truncated tools.
        expect(native).not.toContain('"type":"compaction"');
        expect(native).toContain('"stopReason":"length"');
      } else {
        expect(native).toContain('"type":"compaction"');
        expect(result.usage).toEqual({ inputTokens: 124, outputTokens: 32, totalTokens: 156 });
        const trajectory = (await readFile(join(attemptPaths.agent, "trajectory.jsonl"), "utf8")).trim().split("\n")
          .map(line => JSON.parse(line) as TrajectoryEvent);
        expect(trajectory.filter(event => event.type === "usage").length).toBeGreaterThanOrEqual(2);
        expect(trajectory.filter(event => event.type === "usage").at(-1)?.data)
          .toMatchObject({ inputTokens: 124, outputTokens: 32, totalTokens: 156 });
        expect(warnings).toHaveLength(0);
      }
    } finally { await session.dispose(new AbortController().signal); }
  }, 35_000);

  test("rejects malformed and missing terminal protocol messages", async () => {
    const attemptPaths = await paths("protocol-errors");
    const context = {
      key: { runId: "run", taskId: "protocol", attemptId: "attempt" },
      paths: attemptPaths,
      signal: new AbortController().signal,
    };
    const solver = new SimpleAgentSolver(
      { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
      { value: "secret", reference: null },
    );
    await expect(solver.solve({ id: "task", prompt: "task" }, fakeSession(root, "not-json\n"), context))
      .rejects.toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
    await expect(solver.solve({ id: "task", prompt: "task" }, fakeSession(root, ""), context))
      .rejects.toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
  });

  test.each([undefined, "0", "1"])("uses target POSIX paths without injecting HTTP/2 policy (%s) for a non-local Linux session", async value => {
    vi.stubEnv("EVALUATOR_HTTP2", value);
    const attemptPaths = await paths("remote-paths");
    const commands: Parameters<EnvironmentSession["start"]>[0][] = [];
    const uploads: string[] = [];
    const solver = new SimpleAgentSolver(
      { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
      { value: "secret", reference: null },
    );
    await expect(solver.solve({ id: "task", prompt: "task" }, remoteSession(commands, uploads), {
      key: { runId: "run", taskId: "remote", attemptId: "attempt" },
      paths: attemptPaths,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ finalText: "done" });
    expect(uploads).toEqual([]);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toEqual(["/opt/evaluator-agent/dist/runtimes/pi/runner.js"]);
    expect(commands[0]?.env).toEqual({});
  });

  test("rejects a direct solve when the environment has not prepared a runtime", async () => {
    const attemptPaths = await paths("unprepared-runtime");
    const commands: Parameters<EnvironmentSession["start"]>[0][] = [];
    const uploads: string[] = [];
    const solver = new SimpleAgentSolver(
      { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
      { value: "secret-token", reference: null },
    );
    await expect(solver.solve({ id: "task", prompt: "task" }, remoteSession(commands, uploads, false), {
      key: { runId: "run", taskId: "remote", attemptId: "attempt" },
      paths: attemptPaths,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED" });
    expect(commands).toEqual([]);
    expect(uploads).toEqual([]);
  });

  test("declares packaged Pi assets and npm installation before solving", async () => {
    const solver = new SimpleAgentSolver(
      { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
      { value: "secret-token", reference: null },
    );
    const installation = await solver.runtimeInstallation!(new AbortController().signal);
    expect(installation.id).toBe(await loadBuiltinRuntimeDigest());
    expect(installation.files).toEqual([
      { source: resolve("dist/runtimes/pi/runtime-package.json"), target: "package.json" },
      { source: resolve("dist/runtimes/pi/runtime-lock.json"), target: "package-lock.json" },
      { source: resolve("dist/runtimes/pi"), target: "dist/runtimes/pi" },
    ]);
    expect(installation.commands).toEqual([{
      executable: "npm",
      args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=verbose", "--logs-dir={root}/.npm-logs", "--logs-max=1"],
    }]);
    expect(installation.probes).toEqual([expect.objectContaining({ executable: "node" })]);
    expect(JSON.stringify(installation.probes)).not.toMatch(/(?:src\/|tsx|ts-node|pnpm)/u);
    expect(JSON.stringify(installation)).not.toContain("secret-token");
    expect(installation.localRoot).toBe(resolve("."));
    const runtimeManifest = JSON.parse(await readFile(resolve("dist/runtimes/pi/runtime-package.json"), "utf8"));
    const runtimeLock = JSON.parse(await readFile(resolve("dist/runtimes/pi/runtime-lock.json"), "utf8"));
    expect(runtimeManifest.dependencies).not.toHaveProperty("agent-bundle-core");
    expect(runtimeLock.packages[""].dependencies).not.toHaveProperty("agent-bundle-core");
    expect(runtimeLock.packages).not.toHaveProperty("node_modules/agent-bundle-core");
  });

  test("keeps usage unknown when the provider does not report token counts", async () => {
    const attemptPaths = await paths("no-usage");
    const workspaceRoot = join(root, "no-usage-workspaces");
    await mkdir(workspaceRoot, { recursive: true });
    const environment = new LocalEnvironment(workspaceRoot);
    const model = { name: "fixture-model", endpoint, provider: null, api: "openai-completions" };
    const solver = new SimpleAgentSolver(model, { value: "key-no-usage", reference: null });
    const signal = new AbortController().signal;
    const context = { key: { runId: "run", taskId: "no-usage", attemptId: "attempt" }, paths: attemptPaths, signal };
    const { session, prepared } = await prepareSimpleAgent(environment, solver, attemptPaths, context);
    try {
      const result = await prepared.solve({ id: "no-usage", prompt: "complete no-usage" }, context);
      expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
    } finally {
      await session.dispose(new AbortController().signal);
    }
  }, 30_000);

  test("cancellation preserves a partial trajectory without an end record", async () => {
    const attemptPaths = await paths("cancel");
    const workspaceRoot = join(root, "cancel-workspaces");
    await mkdir(workspaceRoot, { recursive: true });
    const environment = new LocalEnvironment(workspaceRoot);
    const model = { name: "fixture-model", endpoint, provider: null, api: "openai-completions" };
    const solver = new SimpleAgentSolver(model, { value: "key-cancel", reference: null });
    const controller = new AbortController();
    const context = { key: { runId: "run", taskId: "cancel", attemptId: "attempt" }, paths: attemptPaths, signal: controller.signal };
    const { session, prepared } = await prepareSimpleAgent(environment, solver, attemptPaths, context);
    const solving = prepared.solve({ id: "cancel", prompt: "complete cancel" }, context);
    void solving.catch(() => {});
    try {
      await waitForText(statePath, "complete cancel");
      controller.abort();
      await expect(solving).rejects.toMatchObject({ name: "AbortError" });
      const trajectoryText = await readFile(join(attemptPaths.agent, "trajectory.jsonl"), "utf8");
      const events = trajectoryText.trimEnd().split("\n").map(line => JSON.parse(line) as TrajectoryEvent);
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(event => event.type === "end")).toBe(false);
      expect(validateSequence(events).complete).toBe(false);
      expect(await readFile(join(attemptPaths.agent, "session.jsonl"), "utf8")).toMatch(/"type":"session"/u);
    } finally {
      controller.abort();
      await session.dispose(new AbortController().signal);
      await Promise.allSettled([solving]);
    }
  }, 30_000);

  test("a trajectory write failure is surfaced and cannot look complete", async () => {
    const attemptPaths = await paths("write-failure");
    await mkdir(join(attemptPaths.agent, "trajectory.jsonl"));
    const workspaceRoot = join(root, "failure-workspaces");
    await mkdir(workspaceRoot, { recursive: true });
    const environment = new LocalEnvironment(workspaceRoot);
    const model = { name: "fixture-model", endpoint, provider: null, api: "openai-completions" };
    const solver = new SimpleAgentSolver(model, { value: "key-write", reference: null });
    const signal = new AbortController().signal;
    const context = { key: { runId: "run", taskId: "write", attemptId: "attempt" }, paths: attemptPaths, signal };
    const { session, prepared } = await prepareSimpleAgent(environment, solver, attemptPaths, context);
    try {
      await expect(prepared.solve({ id: "write", prompt: "complete alpha" }, context)).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
      expect((await stat(join(attemptPaths.agent, "trajectory.jsonl"))).isDirectory()).toBe(true);
    } finally {
      await session.dispose(new AbortController().signal);
    }
  }, 30_000);

  test.each(["flush", "usage", "end"] as const)("maps a post-start trajectory %s failure to the stable write code", async failurePoint => {
    const attemptPaths = await paths(`post-start-${failurePoint}-failure`);
    const workdir = join(root, `post-start-${failurePoint}-workspace`);
    await mkdir(workdir, { recursive: true });
    const input = projectRunnerInput({
      key: { runId: "run", taskId: "post-start-write", attemptId: "attempt" },
      input: { id: "post-start-write", prompt: "complete alpha" },
      model: { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
      auth: { value: "key-post-start-write", reference: null },
      workdir,
      outputDir: attemptPaths.agent,
    });
    await expect(run(input, {
      createTrajectoryWriter(path, attemptKey) {
        const writer = new TrajectoryWriter(path, attemptKey);
        return {
          append(type, data, durable) {
            if (type === failurePoint) return Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
            return writer.append(type, data, durable);
          },
          flush: () => failurePoint === "flush"
            ? Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" }))
            : writer.flush(),
          close: () => writer.close(),
        };
      },
    })).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
    const trajectoryText = await readFile(join(attemptPaths.agent, "trajectory.jsonl"), "utf8");
    const events = trajectoryText.trimEnd().split("\n").map(line => JSON.parse(line) as TrajectoryEvent);
    expect(events.some(item => item.type === "start")).toBe(true);
    expect(events.some(item => item.type === "end")).toBe(false);
  }, 30_000);
});

describe("simpleagent bundle", () => {
  // The model-server endpoint only exists after beforeAll; build models lazily.
  const bundleModel = () => ({ name: "fixture-model", endpoint, provider: null, api: "openai-completions" });

  async function stubWindowsShell(): Promise<void> {
    if (process.platform !== "win32") return;
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    // Standalone Node distributions may use npm installed in a different PATH directory.
    const npmDirectory = resolve(dirname(await packageManagerCli("npm")), "../../..");
    vi.stubEnv("PATH", [dirname(process.execPath), npmDirectory, join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";"));
    vi.stubEnv("EMBER_BASH_PATH", join(root, "no-git-bash"));
  }

  test("declares bundle assets, pip installation and import probes", async () => {
    const solver = new SimpleAgentSolver(bundleModel(), { value: "key-bundle-install", reference: null },
      { path: join(fixtureRoot, "pi-bundle") });
    const installation = await solver.runtimeInstallation!(new AbortController().signal);
    expect(installation.files.at(-1)).toMatchObject({ target: "bundle" });
    expect(installation.commands).toEqual([
      expect.objectContaining({ executable: "npm" }),
      {
        executable: "python3",
        args: ["-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check",
          "demo-required==1.0.0", "demo-optional==2.0.0"],
      },
    ]);
    expect(installation.probes).toEqual([
      expect.objectContaining({ executable: "node" }),
      { executable: "python3", args: ["-c", "import demo_required"] },
    ]);
    expect(installation.localRoot).toBeUndefined();
    expect(JSON.stringify(installation)).not.toContain("key-bundle-install");
  });

  test("loads extension tools, skills and instructions through the environment runtime", async () => {
    await stubWindowsShell();
    // The fixture lock names packages that do not exist on PyPI; a copy
    // without it keeps the managed runtime install off pip entirely.
    const bundleRoot = join(root, "bundle-clean");
    await cp(join(fixtureRoot, "pi-bundle"), bundleRoot, { recursive: true });
    await rm(join(bundleRoot, "dependencies.lock"));
    const attemptPaths = await paths("bundle-run");
    const workspaceRoot = join(root, "bundle-workspaces");
    await mkdir(workspaceRoot, { recursive: true });
    const environment = new LocalEnvironment(workspaceRoot);
    const solver = new SimpleAgentSolver(bundleModel(), { value: "key-bundle", reference: null }, { path: bundleRoot });
    const signal = new AbortController().signal;
    const context = { key: { runId: "run", taskId: "bundle", attemptId: "attempt" }, paths: attemptPaths, signal };
    const { session, prepared } = await prepareSimpleAgent(environment, solver, attemptPaths, context);
    try {
      const result = await prepared.solve({ id: "bundle", prompt: "complete alpha" }, context);
      expect(result.finalText).toBe("Answer: alpha");
      const requests = (await readFile(statePath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line))
        .filter(request => request.authorization === "Bearer key-bundle");
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        const tools = request.body.tools.map((tool: { function: { name: string } }) => tool.function.name);
        expect(tools).toContain("demo_bundle_echo");
        const system = request.body.messages
          .filter((message: { role: string }) => message.role === "system")
          .map((message: { content: unknown }) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
          .join("\n");
        expect(system).toContain("DEMO_BUNDLE_INSTRUCTIONS");
        expect(system).toContain("demo-skill");
      }
      const marker = await readFile(join(session.workdir, "marker.txt"), "utf8");
      expect(marker).toBe("alpha");
    } finally {
      await session.dispose(new AbortController().signal);
    }
  }, 240_000);

  test("computes target POSIX extension paths for a non-local session", async () => {
    const commands: Parameters<EnvironmentSession["start"]>[0][] = [];
    const uploads: string[] = [];
    const solver = new SimpleAgentSolver(bundleModel(), { value: "key-bundle-remote", reference: null },
      { path: join(fixtureRoot, "pi-bundle") }, { shellTimeoutSeconds: 120, shellMaxTimeoutSeconds: 300 });
    await expect(solver.solve({ id: "task", prompt: "task" }, remoteSession(commands, uploads), {
      key: { runId: "run", taskId: "remote-bundle", attemptId: "attempt" },
      paths: await paths("remote-bundle"),
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ finalText: "done" });
    expect(commands).toHaveLength(1);
    const stdin = parseRunnerInput(JSON.parse((commands[0]?.input ?? Buffer.alloc(0)).toString("utf8")));
    expect(stdin.extensions).toEqual(["/opt/evaluator-agent/bundle/extensions/demo/extension.js"]);
    expect(stdin.toolPolicy).toEqual({ shellTimeoutSeconds: 120, shellMaxTimeoutSeconds: 300 });
  });

  test("loads an isolated AgentBundle Pi config directory without ambient discovery", async () => {
    await stubWindowsShell();
    const attemptPaths = await paths("agentbundle-pi-config");
    const agentDir = join(root, "agentbundle-pi-home");
    const extension = join(agentDir, "extensions", "demo");
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await cp(join(fixtureRoot, "pi-bundle", "extensions", "demo"), extension, { recursive: true });
    await writeFile(join(agentDir, "AGENTS.md"), "AGENTBUNDLE_PI_INSTRUCTIONS\n", "utf8");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [extension], skills: ["skills"] }), "utf8");
    const input = projectRunnerInput({
      key: { runId: "run", taskId: "agentbundle-pi", attemptId: "attempt" },
      input: { id: "agentbundle-pi", prompt: "complete alpha" },
      model: { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
      auth: { value: "key-agentbundle-pi", reference: null },
      workdir: root,
      outputDir: attemptPaths.agent,
      piConfigDir: agentDir,
      piSettings: { version: 1, office: { enabled: true, readOnly: false } },
    });
    const result = await run(input);
    expect(result.finalText).toBe("Answer: alpha");
    const persisted = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({ version: 1, office: { enabled: true, readOnly: false } });
    expect(persisted.extensions).toEqual([extension]);
    const requests = (await readFile(statePath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line))
      .filter(request => request.authorization === "Bearer key-agentbundle-pi");
    expect(requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests)).toContain("AGENTBUNDLE_PI_INSTRUCTIONS");
    expect(JSON.stringify(requests)).toContain("demo_bundle_echo");
  }, 30_000);

  test("task-declared SSE MCP tools are present before model execution and close on completion", async () => {
    await stubWindowsShell();
    const mcp = await taskMcpServer();
    const attemptPaths = await paths("task-mcp");
    try {
      const input = projectRunnerInput({ key: { runId: "run", taskId: "mcp", attemptId: "one" },
        input: { id: "mcp", prompt: "complete alpha", mcpServers: [{ name: "task", transport: "sse", url: mcp.url }] },
        model: { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
        auth: { value: "key-task-mcp", reference: null }, workdir: root, outputDir: attemptPaths.agent });
      expect((await run(input)).finalText).toBe("Answer: alpha");
      const requests = (await readFile(statePath, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(request => request.authorization === "Bearer key-task-mcp");
      expect(JSON.stringify(requests)).toContain("mcp__task__echo");
      expect(mcp.activeConnections()).toBe(0);
    } finally { await mcp.close(); }
  }, 40_000);

  test.skipIf(process.platform === "win32")("task skills load from explicit paths without ambient discovery", async () => {
    const attemptPaths = await paths("task-skills");
    const skills = join(root, "task-skills");
    await mkdir(join(skills, "example"), { recursive: true });
    await writeFile(join(skills, "example/SKILL.md"), "---\nname: task-example\ndescription: TASK_SKILL_DESCRIPTION\n---\nUse this public task skill.\n");
    const input = projectRunnerInput({ key: { runId: "run", taskId: "skills", attemptId: "one" },
      input: { id: "skills", prompt: "complete alpha", skillsDirectories: [skills] },
      model: { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
      auth: { value: "key-task-skills", reference: null }, workdir: root, outputDir: attemptPaths.agent });
    expect((await run(input)).finalText).toBe("Answer: alpha");
    const requests = (await readFile(statePath, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(request => request.authorization === "Bearer key-task-skills");
    expect(JSON.stringify(requests)).toContain("TASK_SKILL_DESCRIPTION");
  }, 30_000);

  test("fails loudly when an extension entry cannot be loaded", async () => {
    await stubWindowsShell();
    const attemptPaths = await paths("bundle-load-failed");
    const input = projectRunnerInput({
      key: { runId: "run", taskId: "bundle-load", attemptId: "attempt" },
      input: { id: "bundle-load", prompt: "complete alpha" },
      model: { name: "fixture-model", endpoint, provider: null, api: "openai-completions" },
      auth: { value: "key-bundle-load", reference: null },
      workdir: root,
      outputDir: attemptPaths.agent,
      extensions: [join(root, "missing-extension.js")],
    });
    await expect(run(input)).rejects.toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED" });
  }, 30_000);
});
