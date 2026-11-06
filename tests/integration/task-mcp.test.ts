import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "vitest";
import { McpClient } from "@earendil-works/pi-mcp";
import { TaskSseTransport } from "../../src/runtimes/pi/mcp.js";

test("task SSE MCP initializes, discovers and calls a tool, then closes without model I/O", async () => {
  let stream: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === "/sse") {
      stream = response; response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("event: endpoint\ndata: /messages\n\n"); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(202); response.end();
    if (message.id === undefined) return;
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }
      : message.method === "tools/list"
        ? { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }] }
        : { content: [{ type: "text", text: message.params.arguments.value }] };
    stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const client = new McpClient({ name: "evaluator-fixture", version: "1", requestTimeoutMs: 2000 });
  try {
    await client.connect(new TaskSseTransport(`http://127.0.0.1:${address.port}/sse`));
    expect((await client.listTools())[0]?.name).toBe("echo");
    expect(await client.callTool("echo", { value: "task-output" })).toMatchObject({ content: [{ type: "text", text: "task-output" }] });
  } finally {
    await client.close(); stream?.end();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 10_000);
