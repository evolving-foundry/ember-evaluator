import { isErrorCode, type ErrorCode } from "../../core/errors/registry.js";
import type { ModelConfig, RuntimeAuth } from "../../core/contracts/config.js";
import type { AttemptKey, SolveResult } from "../../core/contracts/result.js";
import type { PublicTask } from "../../core/contracts/task.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { parseShellToolPolicy, type ShellToolPolicy } from "./tool-policy.js";
import type { ComponentActivity } from "../../core/contracts/activity.js";
import { LIVE_LINES } from "../../core/progress/live-progress.js";

export type RunnerInput = {
  schemaVersion: 1;
  key: AttemptKey;
  input: PublicTask;
  model: ModelConfig;
  auth: RuntimeAuth;
  workdir: string;
  outputDir: string;
  /** Absent keeps the runner's default shell tool policy. */
  toolPolicy?: ShellToolPolicy;
  /** Extension entry files inside the target environment; absent means no extensions. */
  extensions?: string[];
  /** Isolated AgentBundle installation selected instead of ambient Pi config. */
  piConfigDir?: string;
  /** Non-secret per-run Pi settings merged over the installed bundle settings. */
  piSettings?: Record<string, JsonValue>;
};

export type RunnerOutput =
  | { schemaVersion: 1; type: "activity"; activity: ComponentActivity }
  | { schemaVersion: 1; type: "result"; result: SolveResult }
  | { schemaVersion: 1; type: "warning"; code: ErrorCode; message: string }
  | { schemaVersion: 1; type: "error"; code: ErrorCode; message: string; details?: import("../../core/contracts/errors.js").ErrorDetails };

type RunnerInputSource = Omit<RunnerInput, "schemaVersion" | "input"> & {
  input: PublicTask & Record<string, unknown>;
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new TypeError(`${path} contains unknown field ${unknown}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function taskResources(value: Record<string, unknown>): Pick<PublicTask, "skillsDirectories" | "mcpServers"> {
  const resources: Pick<PublicTask, "skillsDirectories" | "mcpServers"> = {};
  if (value.skillsDirectories !== undefined) {
    if (!Array.isArray(value.skillsDirectories) || value.skillsDirectories.some(path => typeof path !== "string" || !path.startsWith("/") || /[\0\\]/u.test(path) || path.split("/").includes("..")))
      throw new TypeError("Task skill directories must be absolute container paths");
    resources.skillsDirectories = value.skillsDirectories as string[];
  }
  if (value.mcpServers !== undefined) {
    if (!Array.isArray(value.mcpServers)) throw new TypeError("Task MCP servers must be an array");
    resources.mcpServers = value.mcpServers.map(raw => {
      const server = record(raw, "task.mcpServer"); fields(server, ["name", "transport", "url"], "task.mcpServer");
      const name = text(server.name, "task.mcpServer.name");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(name)) throw new TypeError("Invalid MCP server name");
      const transport = server.transport;
      if (transport !== "sse" && transport !== "http") throw new TypeError("Only SSE/HTTP MCP is supported");
      const url = text(server.url, "task.mcpServer.url");
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new TypeError("Invalid MCP server URL");
      return { name, transport, url };
    });
    if (new Set(resources.mcpServers.map(server => server.name)).size !== resources.mcpServers.length) throw new TypeError("Duplicate MCP server names");
  }
  return resources;
}

export function projectRunnerInput(source: RunnerInputSource): RunnerInput {
  return {
    schemaVersion: 1,
    key: { runId: source.key.runId, taskId: source.key.taskId, attemptId: source.key.attemptId },
    input: { id: source.input.id, prompt: source.input.prompt, ...taskResources(source.input) },
    model: {
      name: source.model.name,
      endpoint: source.model.endpoint,
      provider: source.model.provider,
      api: source.model.api,
      ...(source.model.maxTokens === undefined ? {} : { maxTokens: source.model.maxTokens }),
      ...(source.model.contextWindow === undefined ? {} : { contextWindow: source.model.contextWindow }),
      ...(source.model.retry === undefined ? {} : { retry: source.model.retry }),
    },
    auth: { value: source.auth.value, reference: source.auth.reference },
    workdir: source.workdir,
    outputDir: source.outputDir,
    ...(source.toolPolicy === undefined ? {} : { toolPolicy: source.toolPolicy }),
    ...(source.extensions === undefined ? {} : { extensions: [...source.extensions] }),
    ...(source.piConfigDir === undefined ? {} : { piConfigDir: source.piConfigDir }),
    ...(source.piSettings === undefined ? {} : { piSettings: JSON.parse(JSON.stringify(source.piSettings)) as Record<string, JsonValue> }),
  };
}

export function parseRunnerInput(value: unknown): RunnerInput {
  const root = record(value, "runner input");
  fields(root, ["schemaVersion", "key", "input", "model", "auth", "workdir", "outputDir", "extensions", "piConfigDir", "piSettings", "toolPolicy"], "runner input");
  if (root.schemaVersion !== 1) throw new TypeError("runner input schemaVersion must be 1");
  const toolPolicy =
    root.toolPolicy === undefined ? undefined : parseShellToolPolicy(root.toolPolicy, "runner input.toolPolicy");
  const key = record(root.key, "runner input.key");
  fields(key, ["runId", "taskId", "attemptId"], "runner input.key");
  const input = record(root.input, "runner input.input");
  fields(input, ["id", "prompt", "skillsDirectories", "mcpServers"], "runner input.input");
  const model = record(root.model, "runner input.model");
  fields(model, ["name", "endpoint", "provider", "api", "maxTokens", "contextWindow", "retry"], "runner input.model");
  if (model.contextWindow !== undefined && (typeof model.contextWindow !== "number" || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0))
    throw new TypeError("runner input.model.contextWindow must be a positive integer");
  if (model.maxTokens !== undefined && (typeof model.maxTokens !== "number" || !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0))
    throw new TypeError("runner input.model.maxTokens must be a positive integer greater than zero");
  let retry: { maxAttempts: number } | undefined;
  if (model.retry !== undefined) {
    const value = record(model.retry, "runner input.model.retry");
    fields(value, ["maxAttempts"], "runner input.model.retry");
    if (typeof value.maxAttempts !== "number" || !Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 1) {
      throw new TypeError("runner input.model.retry.maxAttempts must be a positive integer greater than zero");
    }
    retry = { maxAttempts: value.maxAttempts };
  }
  const auth = record(root.auth, "runner input.auth");
  fields(auth, ["value", "reference"], "runner input.auth");
  return {
    schemaVersion: 1,
    key: {
      runId: text(key.runId, "runner input.key.runId"),
      taskId: text(key.taskId, "runner input.key.taskId"),
      attemptId: text(key.attemptId, "runner input.key.attemptId"),
    },
    input: {
      id: text(input.id, "runner input.input.id"),
      prompt: text(input.prompt, "runner input.input.prompt"),
      ...taskResources(input),
    },
    model: {
      name: text(model.name, "runner input.model.name"),
      endpoint: nullableText(model.endpoint, "runner input.model.endpoint"),
      provider: nullableText(model.provider, "runner input.model.provider"),
      api: nullableText(model.api, "runner input.model.api"),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(retry === undefined ? {} : { retry }),
    },
    auth: {
      value: text(auth.value, "runner input.auth.value"),
      reference: nullableText(auth.reference, "runner input.auth.reference"),
    },
    workdir: text(root.workdir, "runner input.workdir"),
    outputDir: text(root.outputDir, "runner input.outputDir"),
    ...(toolPolicy === undefined ? {} : { toolPolicy }),
    ...(root.extensions === undefined ? {} : { extensions: extensionPaths(root.extensions) }),
    ...(root.piConfigDir === undefined ? {} : { piConfigDir: text(root.piConfigDir, "runner input.piConfigDir") }),
    ...(root.piSettings === undefined ? {} : { piSettings: jsonRecord(root.piSettings, "runner input.piSettings") }),
  };
}

function jsonRecord(value: unknown, path: string): Record<string, JsonValue> {
  const object = record(value, path);
  try {
    return JSON.parse(JSON.stringify(object)) as Record<string, JsonValue>;
  } catch (error) {
    throw new TypeError(`${path} must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extensionPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("runner input.extensions must be a non-empty array of paths");
  }
  return value.map((item, index) => text(item, `runner input.extensions[${index}]`));
}

export function parseRunnerOutput(value: unknown): RunnerOutput {
  const root = record(value, "runner output");
  if (root.schemaVersion !== 1) throw new TypeError("runner output schemaVersion must be 1");
  if (root.type === "activity") {
    fields(root, ["schemaVersion", "type", "activity"], "runner output");
    const activity = record(root.activity, "runner output.activity");
    fields(activity, ["message", "lines", "activity", "operationId", "status"], "runner output.activity");
    if (activity.message !== undefined && (typeof activity.message !== "string" || activity.message.length > 4096)) throw new TypeError("Invalid activity message");
    if (activity.lines !== undefined && (!Array.isArray(activity.lines) || activity.lines.length > LIVE_LINES || activity.lines.some(line => typeof line !== "string" || Buffer.byteLength(line) > 2048))) throw new TypeError("Invalid activity lines");
    if (activity.activity !== undefined && typeof activity.activity !== "boolean") throw new TypeError("Invalid activity flag");
    if (activity.operationId !== undefined) text(activity.operationId, "runner output.activity.operationId");
    if (activity.status !== undefined && !["started", "updated", "completed", "failed", "cancelled"].includes(String(activity.status))) throw new TypeError("Invalid activity status");
    return { schemaVersion: 1, type: "activity", activity: {
      ...(typeof activity.message === "string" ? { message: activity.message } : {}),
      ...(Array.isArray(activity.lines) ? { lines: activity.lines as string[] } : {}),
      ...(typeof activity.activity === "boolean" ? { activity: activity.activity } : {}),
      ...(typeof activity.operationId === "string" ? { operationId: activity.operationId } : {}),
      ...(typeof activity.status === "string" ? { status: activity.status as NonNullable<ComponentActivity["status"]> } : {}),
    } };
  }
  if (root.type === "error" || root.type === "warning") {
    fields(root, ["schemaVersion", "type", "code", "message", ...(root.type === "error" ? ["details"] : [])], "runner output");
    if (!isErrorCode(root.code)) throw new TypeError("runner output.code must be a registered error code");
    return {
      schemaVersion: 1,
      type: root.type,
      code: root.code,
      message: text(root.message, "runner output.message"),
      ...(root.type === "error" && root.details !== undefined ? { details: jsonRecord(root.details, "runner output.details") } : {}),
    };
  }
  if (root.type !== "result") throw new TypeError("runner output type is not recognized");
  fields(root, ["schemaVersion", "type", "result"], "runner output");
  const result = record(root.result, "runner output.result");
  fields(result, ["finalText", "usage"], "runner output.result");
  const usage = record(result.usage, "runner output.result.usage");
  fields(usage, ["inputTokens", "outputTokens", "totalTokens"], "runner output.result.usage");
  const token = (item: unknown, path: string): number | null => {
    if (item === null) return null;
    if (!Number.isSafeInteger(item) || (item as number) < 0)
      throw new TypeError(`${path} must be a non-negative integer or null`);
    return item as number;
  };
  return {
    schemaVersion: 1,
    type: "result",
    result: {
      finalText: typeof result.finalText === "string" ? result.finalText : text(result.finalText, "runner output.result.finalText"),
      usage: {
        inputTokens: token(usage.inputTokens, "runner output.result.usage.inputTokens"),
        outputTokens: token(usage.outputTokens, "runner output.result.usage.outputTokens"),
        totalTokens: token(usage.totalTokens, "runner output.result.usage.totalTokens"),
      },
    },
  };
}
