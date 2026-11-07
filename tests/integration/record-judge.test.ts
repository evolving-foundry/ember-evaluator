import { createServer } from "node:http";
import { expect, test } from "vitest";
import { simpleqaDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/simpleqa.js";
import { math500Definition } from "../../src/plugins/benchmarks/agent-harness/definitions/math500.js";

test.each([simpleqaDefinition, math500Definition].flatMap(definition =>
  [undefined, 1234].map(maxTokens => ({ definition, maxTokens }))))("$definition.name judge uses the selected credential and output ceiling $maxTokens", async ({ definition, maxTokens }) => {
  const requests: { auth: string | undefined; model: unknown; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let data = "";
    for await (const chunk of request) data += String(chunk);
    const input = JSON.parse(data);
    requests.push({ auth: request.headers.authorization, model: input.model, body: input });
    response.setHeader("content-type", "text/event-stream");
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model,
      choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", content: definition.name === "math500" ? "Yes" : "A" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model,
      choices: [{ index: 0, finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port");
    const verdict = await definition.verify({ kind: definition.name === "math500" ? "math" : "judge", instruction: "q", expected: "a" }, "Answer: a", {
      dockerExecutable: "docker", judgeService: "independent", judge: {
        model: { name: "judge-only", endpoint: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", provider: null,
          ...(maxTokens === undefined ? {} : { maxTokens }) },
        auth: { value: "judge-credential", reference: "JUDGE_KEY" },
      },
    }, AbortSignal.timeout(5000));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ auth: "Bearer judge-credential", model: "judge-only" });
    const body = requests[0]?.body;
    if (!body) throw new Error("No captured judge request");
    expect(body.messages).toEqual([expect.objectContaining({ role: "user", content: expect.stringContaining(definition.name === "math500"
      ? 'Respond with only "Yes" or "No"' : 'Just return the letters "A", "B", or "C"') })]);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(maxTokens);
    if (maxTokens === undefined) {
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("max_completion_tokens");
      expect(verdict.details).toMatchObject({ parameters: { maxTokens: null, outputLimit: "provider-default" } });
    }
    expect(verdict).toMatchObject({ passed: true, details: { judgeModel: "judge-only" } });
    expect(JSON.stringify(verdict)).not.toContain("judge-credential");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
