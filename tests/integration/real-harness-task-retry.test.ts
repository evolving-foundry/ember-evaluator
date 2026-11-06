import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { runEngine } from "../../src/application/run-engine.js";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";
import { consumeJiuwenswarm } from "../../src/runtimes/jiuwenswarm/protocol.js";
import { dshModelPatch, dshPermissionPatch } from "../../src/runtimes/dsh/model.js";
import type { ProcessHandle } from "../../src/core/contracts/environment.js";
import { harness } from "../fixtures/engine/fakes.js";

const runtime = process.env.EVALUATOR_TEST_REAL_HARNESS_RUNTIME;
const image = process.env.EVALUATOR_TEST_REAL_DSH_IMAGE;
const output = process.env.EVALUATOR_TEST_REAL_HARNESS_OUTPUT;
const exact = "litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: ChatgptException - Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>";
type Solver = "dsh" | "jiuwenswarm" | "deepagents";
type Fault = "healthy" | "socket-once" | "sse-once" | "sse-always" | "http-400";
const chunk = (content: string, finish: string | null = null) => ({ id: "fixture", object: "chat.completion.chunk",
  created: 1, model: "gpt-4.1", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }] });

function launch(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string,
  capture: { stdout: string; stderr: string }): ProcessHandle {
  const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on("data", data => { capture.stdout += String(data); });
  child.stderr.on("data", data => { capture.stderr += String(data); });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return { stdout: child.stdout, stderr: child.stderr, done, async stop() { child.kill("SIGTERM"); await done; } };
}

async function exercise(solver: Solver, fault: Fault) {
  const root = await mkdtemp(join(output ?? tmpdir(), `real-task-${solver}-${fault}-`));
  const value = harness(root);
  value.config.experiment.run.taskIds = ["a"];
  value.config.experiment.run.timeoutSeconds = 150;
  value.config.experiment.run.onError = "abort";
  const calls: { attempt: number; stream: boolean; title: boolean; fault: string }[] = [];
  const processes: { attempt: number; stdout: string; stderr: string; code?: number | null }[] = [];
  const retries: string[] = [];
  let attempt = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    if (req.method !== "POST") { res.end(JSON.stringify({ data: [{ id: "gpt-4.1" }] })); return; }
    const body = JSON.parse(raw) as { stream?: boolean; messages?: { role: string; content: unknown }[] };
    const title = body.messages?.some(message => message.role === "system" && typeof message.content === "string" && message.content.startsWith("Create a concise title")) ?? false;
    const index = calls.filter(call => !call.title).length;
    const failing = !title && (fault === "sse-always" || fault === "http-400" || (fault !== "healthy" && index === 0));
    calls.push({ attempt, stream: body.stream === true, title, fault: failing ? fault : "healthy" });
    if (failing && fault === "http-400") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid model parameter", type: "invalid_request_error" } })); return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", ...(failing && fault === "socket-once" ? { "Content-Length": "65536" } : {}) });
    res.write(`data: ${JSON.stringify(chunk(failing ? "PARTIAL" : "FIXTURE_OK"))}\n\n`);
    if (failing) {
      if (fault === "socket-once") setTimeout(() => res.destroy(), 100);
      else res.end(`data: ${JSON.stringify({ error: { message: exact, type: "api_error" } })}\n\n`);
    } else res.end(`data: ${JSON.stringify(chunk("", "stop"))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing gateway port");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  value.components.solver.solve = async (_input, session, context) => {
    attempt++;
    const home = join(session.workdir, "home");
    await mkdir(home);
    const env = { PATH: process.env.PATH, HOME: home, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1",
      LANGSMITH_TRACING: "false", HF_HUB_OFFLINE: "1", NO_PROXY: "127.0.0.1,localhost" };
    const capture = { attempt, stdout: "", stderr: "", code: null as number | null };
    processes.push(capture);
    let handle: ProcessHandle;
    if (solver === "deepagents") {
      const bundle = join(home, "bundle"); await mkdir(bundle);
      await writeFile(join(bundle, "agent.py"), `import os\nfrom deepagents import create_deep_agent\nfrom langchain_openai import ChatOpenAI\ndef build_agent(middleware):\n    model = ChatOpenAI(model='gpt-4.1', base_url=os.environ['AGENT_MODEL_BASE_URL'], api_key=os.environ['AGENT_MODEL_API_KEY'], streaming=True, timeout=10)\n    return create_deep_agent(model=model, middleware=list(middleware))\n`);
      handle = launch(join(runtime!, "deep-env/bin/python"), [resolve("src/runtimes/deepagents/assets/runner.py"), "--bundle-dir", bundle], session.workdir,
        { ...env, AGENT_MODEL_NAME: "gpt-4.1", AGENT_MODEL_BASE_URL: endpoint, AGENT_MODEL_API_KEY: "fixture-key" }, "Respond FIXTURE_OK without tools.", capture);
    } else if (solver === "jiuwenswarm") {
      await mkdir(join(home, "config"));
      await writeFile(join(home, "config/config.yaml"), await readFile(join(runtime!, "swarm-source/jiuwenswarm/resources/config.yaml")));
      handle = launch(join(runtime!, "swarm-env/bin/jiuwenswarm-process"), ["Respond FIXTURE_OK without tools.", "--output", "json", "--cwd", session.workdir, "--timeout", "100"], session.workdir,
        { ...env, JIUWENSWARM_DATA_DIR: home, API_BASE: endpoint, API_KEY: "fixture-key", MODEL_NAME: "gpt-4.1", MODEL_PROVIDER: "OpenAI", ENDPOINT_PROFILE: "openai" }, "", capture);
    } else {
      const cli = "/opt/evaluator-agent/node_modules/@deepseek-ai/dsh/lib/bin.js";
      const docker = ["run", "--rm", "--network", "host", "--user", `${process.getuid!()}:${process.getgid!()}`, "-i", "-v", `${session.workdir}:${session.workdir}`, "-w", session.workdir,
        "-v", `${resolve("src/runtimes/dsh/assets/output-hook.mjs")}:/tmp/evaluator-output-hook.mjs:ro`,
        "-v", `${context.paths.agent}:${context.paths.agent}`, "-e", `EVALUATOR_DSH_OUTPUT_DIR=${context.paths.agent}`,
        "-e", `HOME=${home}`, "-e", `DSH_HOME=${home}`, "-e", "DSH_PERMISSION_MODE=danger-full-access", "-e", "EMBER_EVALUATOR_API_KEY=fixture-key", "-e", "DSH_TELEMETRY_DISABLED=1", "--entrypoint", "node", image!];
      const setup = { stdout: "", stderr: "" };
      const config = launch("docker", [...docker, cli, "--profile", "evaluator", "--from-default-profile", "headless", "--dump-config"], session.workdir, env, "", setup);
      // Drain both streams; config creation is a real CLI command, not a fabricated profile.
      await Promise.all([(async () => { for await (const _ of config.stdout) {} })(), (async () => { for await (const _ of config.stderr) {} })()]);
      expect((await config.done).code, setup.stderr).toBe(0);
      expect(setup.stdout).toContain("id: llm-retry");
      await writeFile(join(home, "model.patch.yaml"), dshModelPatch({ name: "gpt-4.1", endpoint, provider: "openai", api: "openai-completions" }));
      await writeFile(join(home, "permissions.yaml"), dshPermissionPatch("danger-full-access"));
      handle = launch("docker", [...docker, "--import", "/tmp/evaluator-output-hook.mjs", cli, "--profile", "evaluator",
        "--patch", join(home, "model.patch.yaml"), "--patch", join(home, "permissions.yaml"), "--json"], session.workdir, env, "Respond FIXTURE_OK without tools.", capture);
    }
    try {
      return await (solver === "jiuwenswarm" ? consumeJiuwenswarm(handle, context, "fixture-key")
        : consumeDsh(handle, context, "fixture-key", undefined, solver.toUpperCase()));
    } finally {
      capture.code = (await handle.done).code;
      await writeFile(join(context.paths.agent, "real-process.json"), JSON.stringify(capture, null, 2));
    }
  };
  try {
    const result = await runEngine({ ...value, signal: AbortSignal.timeout(240_000), onProgress: event => {
      if (event.phase === "retry") retries.push(event.message);
    } });
    const attempts = await value.components.store.listAttempts();
    const summary = { solver, fault, root, requests: calls.filter(call => !call.title).length, calls,
      taskAttempts: attempts.length, automaticRetries: retries, status: result.run.status,
      attempts: attempts.map(item => ({ ordinal: item.ordinal, key: item.key, executionStatus: item.record?.executionStatus,
        scoreStatus: item.record?.scoreStatus, cleanupStatus: item.record?.cleanupStatus, errors: item.record?.errors })) };
    await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2));
    await writeFile(join(root, "processes.json"), JSON.stringify(processes, null, 2));
    console.log(JSON.stringify(summary));
    expect(summary.requests).toBeGreaterThan(0);
    expect(calls.every(call => call.stream)).toBe(true);
    const expectedAttempts = fault === "sse-once" ? 2 : fault === "sse-always" ? 3 : 1;
    expect(attempts).toHaveLength(expectedAttempts);
    expect(retries).toHaveLength(expectedAttempts - 1);
    const recovered = fault === "healthy" || fault === "sse-once" || (fault === "socket-once" && solver === "dsh");
    expect(result.run.status).toBe(recovered ? "completed" : "error");
    expect(summary.requests).toBe(fault === "socket-once" && solver === "dsh" ? 2 : expectedAttempts);
    expect(new Set(attempts.map(item => item.key.attemptId)).size).toBe(expectedAttempts);
    expect(attempts.every(item => item.record?.cleanupStatus === "cleaned")).toBe(true);
    for (const item of attempts.filter(item => item.record?.executionStatus === "failed")) {
      expect(item.record?.scoreStatus).toBe("invalid");
      expect(item.record?.verdict).toBeNull();
    }
    if (fault.startsWith("sse-")) expect(attempts[0]?.record?.errors[0]?.details.networkReason).toBe("response-truncated");
    // Document the actual gap: Python harnesses erase the physical truncation
    // cause. Their generic connection errors do not qualify for automatic retry.
    if (fault === "socket-once" && solver !== "dsh")
      expect(attempts[0]?.record?.errors[0]?.message).toContain("Connection error.");
    return summary;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await value.components.dispose();
  }
}

test.skipIf(!runtime || !image || !output).concurrent.each(["dsh", "jiuwenswarm", "deepagents"] as const)(
  "real %s reports model failures to task retry admission", async solver => {
    await mkdir(output!, { recursive: true });
    for (const fault of ["healthy", "socket-once", "sse-once", "sse-always", "http-400"] as const) await exercise(solver, fault);
  }, 600_000,
);
