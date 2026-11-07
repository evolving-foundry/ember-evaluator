import { createMcpExtension, type McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { parseJsonRpcMessage, StreamableHttpTransport, type McpTransport, type JsonRpcMessage } from "@earendil-works/pi-mcp";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PublicTask } from "../../core/contracts/task.js";

/** Adapt upstream legacy SSE to Pi's message and lifecycle contract. */
export class TaskSseTransport implements McpTransport {
  private readonly transport: SSEClientTransport;
  private readonly messages = new Set<Parameters<McpTransport["onMessage"]>[0]>();
  private readonly errors = new Set<Parameters<McpTransport["onError"]>[0]>();
  private readonly closes = new Set<Parameters<McpTransport["onClose"]>[0]>();
  constructor(url: string) {
    this.transport = new SSEClientTransport(new URL(url));
    this.transport.onmessage = message => { const parsed = parseJsonRpcMessage(message); for (const listener of this.messages) listener(parsed); };
    this.transport.onerror = error => { for (const listener of this.errors) listener(error); };
    this.transport.onclose = () => { for (const listener of this.closes) listener(); };
  }
  start(): Promise<void> { return this.transport.start(); }
  send(message: JsonRpcMessage): Promise<void> { return this.transport.send(JSONRPCMessageSchema.parse(message)); }
  close(): Promise<void> { return this.transport.close(); }
  setProtocolVersion(version: string): void { this.transport.setProtocolVersion(version); }
  onMessage(listener: Parameters<McpTransport["onMessage"]>[0]): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onError(listener: Parameters<McpTransport["onError"]>[0]): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  onClose(listener: Parameters<McpTransport["onClose"]>[0]): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
}

export function taskMcpExtension(servers: NonNullable<PublicTask["mcpServers"]>, logPath?: string) {
  const createTransport: McpTransportFactory = entry => {
    const server = servers.find(server => server.name === entry.name);
    if (!server) throw new Error(`Undeclared task MCP server ${entry.name}`);
    return server.transport === "sse" ? new TaskSseTransport(server.url) : new StreamableHttpTransport({ url: server.url });
  };
  return { name: "evaluator-task-mcp", factory: createMcpExtension({
    loadConfig: () => ({ servers: servers.map(server => ({ name: server.name, source: "task", scope: "extension" as const,
      config: { type: "http" as const, url: server.url, exposure: "direct" as const } })), errors: [], autoEnableCodemode: false }),
    createTransport, startupWaitMs: 30_000,
    ...(logPath === undefined ? {} : { logPath }),
    openUrl: () => { throw new Error("Task MCP authentication requires explicit configuration; interactive sign-in is disabled"); },
  }) };
}
