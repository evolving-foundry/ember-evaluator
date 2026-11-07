import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ChoiceLogprobsSolver } from "../../src/plugins/solvers/choice-logprobs.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { requestChatLogprobs } from "../../src/infrastructure/models/chat-logprobs.js";
import { trajectoryType } from "../../src/core/results/record-validation.js";

test("choice-logprobs sends one direct request and retains probability evidence without credentials", async () => {
  let captured: Record<string, unknown> | undefined;
  let auth: string | undefined;
  let rejected = false;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    captured = JSON.parse(text); auth = request.headers.authorization;
    response.setHeader("Content-Type", "application/json");
    if (rejected) { response.writeHead(400); response.end(JSON.stringify({ error: "logprobs unsupported fixture-secret" })); return; }
    response.end(JSON.stringify({ model: "served-model", choices: [{ message: { content: "B" }, finish_reason: "length",
      logprobs: { content: [{ token: "B", logprob: -0.2, top_logprobs: [{ token: "B", logprob: -0.2 }, { token: " A", logprob: -4 }] }] } }],
      usage: { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const model = { name: "requested-model", endpoint: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", provider: null, maxTokens: 1000 };
  const binding = { value: "fixture-secret", reference: "KEY" };
  const root = await mkdtemp(join(tmpdir(), "choice-logprobs-"));
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  const signal = AbortSignal.timeout(10000);
  const session = await new LocalEnvironment().prepare({ workdir: ".", image: null, initialFiles: [], runtime: [] }, paths, "solve", signal);
  try {
    const solver = new ChoiceLogprobsSolver({ topLogprobs: 20, thinking: "disabled" }, model, binding, "local");
    const result = await solver.solve({ id: "task", prompt: "question" }, session, { signal, paths, key: { runId: "run", taskId: "task", attemptId: "attempt" } });
    expect(auth).toBe("Bearer fixture-secret");
    expect(captured).toEqual({ model: "requested-model", messages: [{ role: "user", content: "question" }], max_tokens: 1,
      temperature: 0, stream: false, logprobs: true, top_logprobs: 20, thinking: { type: "disabled" } });
    expect(result).toMatchObject({ finalText: "B", usage: { inputTokens: 30, outputTokens: 1, totalTokens: 31 }, observations: {
      protocol: "chat-logprobs-v1", model: "served-model", token: { token: "B", logprob: -0.2 }, promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    } });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    const trace = await readFile(join(paths.agent, "trajectory.jsonl"), "utf8");
    expect(trace).not.toContain("fixture-secret");
    const events: unknown[] = trace.trim().split("\n").map(line => JSON.parse(line));
    expect(events.map((event, index) => trajectoryType(event, { runId: "run", taskId: "task", attemptId: "attempt" }, index + 1)))
      .toEqual(["start", "message", "usage", "end"]);
    expect(await readFile(join(paths.agent, "session.jsonl"), "utf8")).toBe(trace);
    expect(() => new ChoiceLogprobsSolver({ topLogprobs: 20, thinking: "omit" }, model, binding, "docker")).toThrow(/local/);
    rejected = true;
    const failedPaths = { ...paths, agent: join(root, "failed-agent") };
    await expect(solver.solve({ id: "task", prompt: "question" }, session, { signal, paths: failedPaths,
      key: { runId: "run", taskId: "task", attemptId: "failed" } })).rejects.toThrow(/HTTP 400/);
    const failedTrace = await readFile(join(failedPaths.agent, "trajectory.jsonl"), "utf8");
    expect(failedTrace).not.toContain("fixture-secret");
    expect(JSON.parse(failedTrace.trim().split("\n").at(-1)!)).toMatchObject({ type: "end", data: { status: "failed" } });
  } finally { await session.dispose(AbortSignal.timeout(5000)); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test.each([
  [null, {}, /logprobs/],
  [{ content: [{ token: "B", logprob: -0.1 }] }, {}, /top_logprobs/],
  [{ content: [{ token: "B", logprob: -0.1, top_logprobs: [] }] }, {}, /top_logprobs/],
  [{ content: [] }, {}, /exactly one/],
  [{ content: [{ token: "B", logprob: -0.1, top_logprobs: [{ token: "B", logprob: -0.1 }] }] }, { reasoning_content: "thinking" }, /reasoning tokens/],
])("probability requests reject unsupported or unusable model evidence %j", async (logprobs, extraMessage, message) => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "B", ...extraMessage }, finish_reason: "length", logprobs }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  try {
    await expect(requestChatLogprobs({ name: "test", endpoint: `http://127.0.0.1:${address.port}`, api: "openai-completions", provider: null },
      { value: "fixture-secret", reference: null }, "q", { topLogprobs: 20, thinking: "omit" }, AbortSignal.timeout(5000))).rejects.toThrow(message);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("choice-logprobs redacts rejected requests and respects cancellation", async () => {
  let mode = "error";
  let observed: (() => void) | undefined;
  const server = createServer((_request, response) => {
    if (mode === "wait") { observed?.(); return; }
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "top_logprobs unsupported; fixture-secret" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const model = { name: "test", endpoint: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", provider: null };
  const auth = { value: "fixture-secret", reference: "KEY" };
  try {
    const failure: unknown = await requestChatLogprobs(model, auth, "q", { topLogprobs: 20, thinking: "omit" }, AbortSignal.timeout(5000)).catch((cause: unknown) => cause);
    expect(failure).toHaveProperty("code", "MODEL_REQUEST_INVALID");
    expect(String(failure)).not.toContain("fixture-secret");
    mode = "wait";
    const started = new Promise<void>(resolve => { observed = resolve; });
    const controller = new AbortController();
    const result = requestChatLogprobs(model, auth, "q", { topLogprobs: 20, thinking: "omit" }, controller.signal);
    const checked = expect(result).rejects.toThrow();
    await started;
    controller.abort();
    await checked;
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
