import type { ErrorCode } from "../../core/errors/registry.js";
import {
  createAgentSession,
  createBashToolDefinition,
  createExtensionRuntime,
  createLocalBashOperations,
  createPowerShellToolDefinition,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type SessionStats,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api, type AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonValue } from "../../core/contracts/task.js";
import type { SolveResult } from "../../core/contracts/result.js";
import { parseRunnerInput, type RunnerInput, type RunnerOutput } from "./protocol.js";
import { TrajectoryWriter } from "../../core/artifacts/trajectory.js";
import { findBash } from "../../infrastructure/shell/bash.js";
import { findPowerShell, shellToolName } from "../../infrastructure/shell/shell.js";
import { powerShellOperations } from "../../infrastructure/shell/powershell.js";
import { DEFAULT_SHELL_TOOL_POLICY, enforceShellTimeout, type ShellToolPolicy } from "./tool-policy.js";
import { loadModelDefaults, outputLimitFor } from "./model-defaults.js";
import { taskMcpExtension } from "./mcp.js";
import { classifyError } from "../../core/errors/classify.js";
import { streamWithProviderOutput } from "../../infrastructure/models/openai-output.js";
import { LIVE_LINES, safeLiveText, toolActivity, toolOutputLines } from "../../core/progress/live-progress.js";
import { installEnvProxy } from "../../infrastructure/network/env-proxy.js";

installEnvProxy();

const SYSTEM_PROMPT =
  "You are an autonomous coding agent. Complete the user's task in the current working directory. Use the available tools when needed, then give a concise final answer.";
const INPUT_LIMIT = 1024 * 1024;

class RunnerFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunnerFailure";
  }
}

type TrajectorySink = Pick<TrajectoryWriter, "append" | "flush" | "close">;

export type RunnerOptions = {
  createTrajectoryWriter?: (path: string, key: RunnerInput["key"]) => TrajectorySink;
};

async function persistTrajectory<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new RunnerFailure("STORE_WRITE_FAILED", message, { cause: error });
  }
}

function json(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack ?? null };
  if (Array.isArray(value)) return value.map(item => json(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) output[key] = json(item, seen);
    seen.delete(value);
    return output;
  }
  return String(value);
}

function redact(value: JsonValue, secret: string): JsonValue {
  if (secret === "") return value;
  if (typeof value === "string") return value.replaceAll(secret, "[redacted]");
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key.replaceAll(secret, "[redacted]"), redact(item, secret)]),
    );
  }
  return value;
}

function explicitResources(systemPrompt: string): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * Build the session resource loader. Without extensions the loader is a fixed
 * baseline (no discovery at all). With extensions the SDK's own loader is used
 * so a bundle behaves exactly as under native Pi, while discovery of project
 * and personal resources stays off: the run differs from the baseline by the
 * extensions alone.
 */
async function resourceLoaderFor(input: RunnerInput, settingsManager: SettingsManager, systemPrompt: string): Promise<ResourceLoader> {
  const skillPaths = input.input.skillsDirectories ?? [];
  const factories = [...(input.input.mcpServers?.length ? [taskMcpExtension(input.input.mcpServers, join(input.outputDir, "mcp.log"))] : [])];
  if (input.piConfigDir !== undefined) {
    const settings = await installedPiSettings(input.piConfigDir);
    const extensions = stringPaths(settings.extensions, "installed Pi settings.extensions");
    const instructions = join(input.piConfigDir, "AGENTS.md");
    const instructionText = await readFile(instructions, "utf8");
    const loader = new DefaultResourceLoader({
      cwd: input.workdir,
      agentDir: input.piConfigDir,
      settingsManager,
      additionalExtensionPaths: extensions,
      additionalSkillPaths: [join(input.piConfigDir, "skills"), ...skillPaths],
      extensionFactories: factories,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: [{ path: instructions, content: instructionText }] }),
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    if (loaded.errors.length > 0) {
      throw new RunnerFailure("ENV_RUNTIME_INSTALL_FAILED",
        `extension load failed: ${loaded.errors.map(error => `${error.path}: ${error.error}`).join("; ")}`);
    }
    if (loaded.extensions.length === 0) throw new RunnerFailure("ENV_RUNTIME_INSTALL_FAILED", "no extension was loaded");
    return loader;
  }
  const extensionPaths = input.extensions ?? [];
  // An empty temporary agent directory keeps the host's personal pi
  // configuration out of the evaluation.
  const agentDir = await mkdtemp(join(tmpdir(), "evaluator-pi-agent-"));
  const loader = new DefaultResourceLoader({
    cwd: input.workdir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    additionalSkillPaths: skillPaths,
    extensionFactories: factories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length > 0) {
    throw new RunnerFailure("ENV_RUNTIME_INSTALL_FAILED",
      `extension load failed: ${loaded.errors.map(error => `${error.path}: ${error.error}`).join("; ")}`);
  }
  if (loaded.extensions.length === 0 && extensionPaths.length > 0) throw new RunnerFailure("ENV_RUNTIME_INSTALL_FAILED", "no extension was loaded");
  return loader;
}

async function installedPiSettings(agentDir: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as unknown;
  } catch (error) {
    throw new RunnerFailure("CONFIG_INVALID", "installed Pi settings.json is missing or invalid", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new RunnerFailure("CONFIG_INVALID", "installed Pi settings.json must be an object");
  return value as Record<string, unknown>;
}

function stringPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || item === ""))
    throw new RunnerFailure("CONFIG_INVALID", `${label} must be a non-empty string array`);
  return value as string[];
}

async function inputFromStdin(): Promise<RunnerInput> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of process.stdin) {
    const chunk = Buffer.from(part as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > INPUT_LIMIT) throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", "runner input exceeds 1 MiB");
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString("utf8").trim();
  if (source === "") throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", "runner stdin is empty");
  try {
    return parseRunnerInput(JSON.parse(source));
  } catch (error) {
    throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/** Reserve headroom the summarizer needs to write a compaction summary. */
export const COMPACTION_RESERVE_TOKENS = 16_384;

/**
 * The context budget controls when the session compacts older history instead of failing on
 * provider-side truncation. The registered window adds the summarizer reserve
 * so compaction triggers exactly at the configured threshold.
 */
export function contextWindowFor(contextBudget: number | undefined): number {
  return (contextBudget ?? 128_000) + COMPACTION_RESERVE_TOKENS;
}

export async function modelFor(input: RunnerInput, runtime: ModelRuntime) {
  const defaults = await loadModelDefaults();
  const registered = input.model.provider === null ? undefined : runtime.getModel(input.model.provider, input.model.name);
  const maxTokens = outputLimitFor(defaults, input.model.name, input.model.provider, input.model.maxTokens, registered?.maxTokens);
  let providerId: string;
  if (input.model.endpoint !== null) {
    if (input.model.api === null)
      throw new RunnerFailure("CONFIG_INVALID", "an explicit endpoint requires an API protocol");
    providerId = "ember-runtime";
    runtime.registerProvider(providerId, {
      name: "Ember runtime provider",
      baseUrl: input.model.endpoint,
      api: input.model.api as Api,
      ...(input.model.api === "openai-completions" && input.model.maxTokens === undefined
        ? { streamSimple: streamWithProviderOutput } : {}),
      models: [
        {
          id: input.model.name,
          name: input.model.name,
          api: input.model.api as Api,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: contextWindowFor(input.model.contextWindow ?? input.model.maxTokens),
          maxTokens,
        },
      ],
    });
  } else {
    if (input.model.provider === null)
      throw new RunnerFailure("CONFIG_INVALID", "a provider is required when endpoint is absent");
    providerId = input.model.provider;
  }
  await runtime.setRuntimeApiKey(providerId, input.auth.value);
  const model = runtime.getModel(providerId, input.model.name);
  if (!model) throw new RunnerFailure("MODEL_REQUEST_INVALID", `model ${providerId}/${input.model.name} is not available`);
  if (input.model.maxTokens === undefined) return { ...model,
    ...(input.model.contextWindow === undefined ? {} : { contextWindow: contextWindowFor(input.model.contextWindow) }),
    maxTokens: outputLimitFor(defaults, input.model.name, input.model.provider, undefined, model.maxTokens) };
  return { ...model, maxTokens: input.model.maxTokens, contextWindow: contextWindowFor(input.model.contextWindow ?? input.model.maxTokens) };
}

function assistantMessages(messages: unknown[]): AssistantMessage[] {
  return messages.filter(
    (message): message is AssistantMessage =>
      typeof message === "object" && message !== null && "role" in message && message.role === "assistant",
  );
}

function sessionUsage(stats: SessionStats): SolveResult["usage"] {
  const { input, output, cacheRead, cacheWrite, total } = stats.tokens;
  return total > 0
    ? { inputTokens: input + cacheRead + cacheWrite, outputTokens: output, totalTokens: total }
    : { inputTokens: null, outputTokens: null, totalTokens: null };
}

function solveResult(messages: unknown[], finalMessage: AssistantMessage | undefined,
  stats: SessionStats): SolveResult {
  const assistants = assistantMessages(messages);
  // The SDK may remove a thinking-only truncated reply from its active context.
  // Keep the observed terminal response so truncation retains its real cause.
  if (finalMessage && assistants.at(-1)?.timestamp !== finalMessage.timestamp) assistants.push(finalMessage);
  const last = assistants.at(-1);
  if (!last) throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", "pi session produced no assistant message");
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    throw new RunnerFailure(
      last.stopReason === "aborted" ? "RUN_CANCELLED" : "INTERNAL_ERROR",
      last.errorMessage ?? `agent stopped with ${last.stopReason}`,
    );
  }
  const finalText = last.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("")
    .trim();
  if (finalText === "" && last.stopReason !== "length")
    throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", "pi session produced no final text");
  return {
    finalText,
    // session.messages contains only the active context after compaction.
    // SDK stats include the complete persisted history and summarization calls.
    usage: sessionUsage(stats),
  };
}

function output(message: RunnerOutput): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Custom shell tool replacing the builtin by name. The operations layer
 * enforces the policy timeout on every command; the underlying execution
 * kills the whole process tree on expiry and reports the timeout to the
 * model as an ordinary tool result so the agent can recover.
 */
function shellToolDefinition(
  shell: ReturnType<typeof shellToolName>,
  workdir: string,
  shellPath: string,
  policy: ShellToolPolicy,
) {
  return shell === "bash"
    ? defineTool(
        createBashToolDefinition(workdir, {
          operations: enforceShellTimeout(createLocalBashOperations({ shellPath }), policy),
        }),
      )
    : defineTool(
        createPowerShellToolDefinition(workdir, {
          operations: enforceShellTimeout(powerShellOperations(shellPath), policy),
        }),
      );
}

export async function run(input: RunnerInput, options: RunnerOptions = {}): Promise<SolveResult> {
  const shell = shellToolName();
  const shellPath = shell === "bash" ? await findBash() : await findPowerShell();
  const tools = [shell, "read", "write", "edit"];
  const systemPrompt = `${SYSTEM_PROMPT} The command tool is ${shell}; use ${shell === "powershell" ? "PowerShell" : "Bash"} syntax for commands.`;
  await mkdir(input.outputDir, { recursive: true });
  const trajectory = (options.createTrajectoryWriter ?? ((path, key) => new TrajectoryWriter(path, key)))(
    join(input.outputDir, "trajectory.jsonl"),
    input.key,
  );
  const sessionPath = join(input.outputDir, "session.jsonl");
  await writeFile(sessionPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const sessionManager = SessionManager.open(sessionPath, input.outputDir, input.workdir);
  // With compaction and extensions disabled, all model/tool content enters the
  // native session through this public SDK method. Redact a copy before the SDK
  // caches or appends it, retaining its native IDs, parent chain and durability.
  // Do not mutate live agent messages (tool arguments still need to execute).
  const appendMessage = sessionManager.appendMessage.bind(sessionManager);
  sessionManager.appendMessage = message =>
    appendMessage(
      redact(JSON.parse(JSON.stringify(message)) as JsonValue, input.auth.value) as unknown as Parameters<
        SessionManager["appendMessage"]
      >[0],
    );
  // Model-call retry budget (default 7 attempts = 1 try + 6 retries). pi-ai classifies
  // retryable provider errors (408/409/429/5xx, network) and applies backoff with
  // Retry-After support; exhausted retries surface as a normal stopReason=error.
  const maxAttempts = input.model.retry?.maxAttempts ?? 7;
  const runtimeSettings = {
      // Long-horizon solves outgrow small context windows; compaction
      // summarizes older history once the context passes the configured
      // maxTokens threshold instead of failing on provider truncation.
      // reserveTokens/keepRecentTokens keep the SDK defaults (16k/20k).
      compaction: { enabled: true },
      // Transient provider failures (stream drops, connection errors, 429/5xx)
      // are retried with backoff inside the agent turn; an exhausted budget still
      // surfaces the original error. Long web/code solves regularly outlive
      // fragile upstream connections, so the default budget is deliberately generous.
      retry: { enabled: maxAttempts > 1, maxRetries: maxAttempts - 1, baseDelayMs: 5_000 },
      defaultTools: tools,
      ...(shell === "bash" ? { shellPath } : {}),
  };
  let settingsManager: SettingsManager;
  if (input.piConfigDir === undefined) {
    settingsManager = SettingsManager.inMemory(runtimeSettings, { projectTrusted: false });
  } else {
    const installedSettings = await installedPiSettings(input.piConfigDir);
    const protectedResources = {
      extensions: installedSettings.extensions,
      skills: installedSettings.skills,
      ...(installedSettings.packages === undefined ? {} : { packages: installedSettings.packages }),
    };
    await writeFile(
      join(input.piConfigDir, "settings.json"),
      `${JSON.stringify({ ...installedSettings, ...(input.piSettings ?? {}), ...protectedResources }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    settingsManager = SettingsManager.create(input.workdir, input.piConfigDir, { projectTrusted: false });
    settingsManager.applyOverrides(runtimeSettings);
  }
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = await modelFor(input, runtime);
  const resourceLoader = await resourceLoaderFor(input, settingsManager, systemPrompt);
  // `tools` deliberately stays out of createAgentSession: the SDK treats that
  // option as an allow-list, which would filter bundle extension tools out of
  // the registry entirely. The settings' defaultTools carry the same baseline
  // set, and the constructor activates every extension-registered tool on top.
  const { session } = await createAgentSession({
    cwd: input.workdir,
    modelRuntime: runtime,
    model,
    customTools: [shellToolDefinition(shell, input.workdir, shellPath, input.toolPolicy ?? DEFAULT_SHELL_TOOL_POLICY)],
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  // Headless modes call bindExtensions after creating a session; without it the
  // SDK never emits session_start or resources_discover, so bundle extensions
  // could not observe the session or contribute skills.
  await session.bindExtensions({
    mode: "print",
    onError: error => {
      process.stderr.write(`extension error (${error.extensionPath}): ${String(error.error)}\n`);
    },
  });
  let writeFailure: unknown;
  const write = (type: string, data: JsonValue, durable = false) => {
    void trajectory.append(type, redact(data, input.auth.value), durable).catch(error => {
      writeFailure ??= error;
      void session.abort().catch(() => {});
    });
  };
  const usageSnapshot = () => {
    const stats = session.getSessionStats();
    return { ...sessionUsage(stats), cost: stats.tokens.total > 0 ? stats.cost : null };
  };
  let finalMessage: AssistantMessage | undefined;
  let lastActivityEmission = -Infinity;
  const activity = (message: string, lines: string[] = [], frequent = false) => {
    const now = performance.now();
    if (frequent && now - lastActivityEmission < 200) return;
    lastActivityEmission = now;
    output({ schemaVersion: 1, type: "activity", activity: { message: safeLiveText(message, [input.auth.value]),
      lines: lines.slice(-LIVE_LINES).map(line => safeLiveText(line, [input.auth.value])) } });
  };
  const event = (value: AgentSessionEvent) => {
    if (value.type === "message_start" && value.message.role === "assistant") activity("Requesting model response");
    else if (value.type === "message_update") activity("Receiving model response", [], true);
    else if (value.type === "tool_execution_start") activity(`Running tool ${value.toolName}`, [toolActivity(value.toolName, value.args)]);
    else if (value.type === "tool_execution_update") activity(`Running tool ${value.toolName}`, toolOutputLines(value.partialResult), true);
    else if (value.type === "tool_execution_end") activity(`Tool ${value.toolName} ${value.isError ? "returned an error" : "completed"}`, toolOutputLines(value.result));
    else if (value.type === "auto_retry_start") activity(`Retrying model request ${value.attempt}/${value.maxAttempts}; waiting ${value.delayMs}ms`);
    else if (value.type === "auto_retry_end") activity(value.success ? "Model request retry completed" : "Model request retry failed");
    else if (value.type === "compaction_start") activity("Compacting context");
    else if (value.type === "compaction_end") activity("Context compaction finished");
    if (value.type === "message_start") write("message_start", { role: value.message.role });
    else if (value.type === "message_end") {
      if (value.message.role === "assistant") finalMessage = value.message;
      write("message", json(value.message), true);
      if (value.message.role === "assistant" && value.message.stopReason === "length") {
        const maxTokens = input.model.endpoint !== null && input.model.api === "openai-completions" && input.model.maxTokens === undefined
          ? undefined : model.maxTokens;
        const warning = { code: "SOLVER_OUTPUT_LIMIT" as const,
          message: `Model output was truncated (stopReason=length; model.maxTokens=${maxTokens ?? "provider-default"}; outputTokens=${value.message.usage.output}; reasoningTokens=${value.message.usage.reasoning ?? "unknown"}); continuing evaluation with the actual output.` };
        output({ schemaVersion: 1, type: "warning", ...warning });
        write("warning", warning, true);
      }
    }
    else if (value.type === "tool_execution_start")
      write("tool_start", json({ id: value.toolCallId, name: value.toolName, args: value.args }));
    else if (value.type === "tool_execution_end")
      write(
        "tool_result",
        json({ id: value.toolCallId, name: value.toolName, result: value.result, isError: value.isError }),
        true,
      );
    else if (value.type === "agent_end") write("agent_end", { willRetry: value.willRetry });
    // Non-message usage (including compaction) must survive a later timeout.
    else if (value.type === "compaction_end" && value.result !== undefined)
      write("usage", json(usageSnapshot()), true);
    else if (value.type === "entry_appended" && value.entry.type !== "message" && "usage" in value.entry)
      write("usage", json(usageSnapshot()), true);
  };
  const unsubscribe = session.subscribe(event);
  const abort = () => {
    void session.abort().catch(() => {});
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as NodeJS.Signals[]) process.on(signal, abort);
  let primaryFailure = false;
  try {
    await persistTrajectory("failed to initialize trajectory", () =>
      trajectory.append(
        "start",
        redact(json({ input: input.input, systemPrompt, model: input.model, tools }), input.auth.value),
        true,
      ),
    );
    await session.prompt(input.input.prompt, { expandPromptTemplates: false, source: "rpc" });
    await persistTrajectory("failed to flush trajectory", () => trajectory.flush());
    if (writeFailure !== undefined)
      throw new RunnerFailure("STORE_WRITE_FAILED", "failed to write trajectory", { cause: writeFailure });
    const result = solveResult(session.messages, finalMessage, session.getSessionStats());
    if (input.auth.value) result.finalText = result.finalText.replaceAll(input.auth.value, "[redacted]");
    await persistTrajectory("failed to write trajectory usage", () =>
      trajectory.append("usage", json(usageSnapshot()), true),
    );
    await persistTrajectory("failed to complete trajectory", () =>
      trajectory.append(
        "end",
        redact(json({ status: "completed", finalText: result.finalText }), input.auth.value),
        true,
      ),
    );
    return result;
  } catch (error) {
    primaryFailure = true;
    const failure =
      writeFailure === undefined
        ? error
        : new RunnerFailure("STORE_WRITE_FAILED", "failed to write trajectory", { cause: writeFailure });
    try {
      await trajectory.append("usage", json(usageSnapshot()), true);
      await trajectory.append("error", redact(json(failure), input.auth.value), true);
    } catch {}
    throw failure;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as NodeJS.Signals[]) process.off(signal, abort);
    unsubscribe();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    try {
      await trajectory.close();
    } catch (error) {
      if (!primaryFailure)
        throw new RunnerFailure("STORE_WRITE_FAILED", "failed to close trajectory", { cause: error });
    }
  }
}

export async function startPiRunner(): Promise<void> {
  let auth = "";
  try {
    const input = await inputFromStdin();
    auth = input.auth.value;
    const result = await run(input);
    output({ schemaVersion: 1, type: "result", result });
  } catch (error) {
    const failure =
      error instanceof RunnerFailure
        ? error
        : new RunnerFailure("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), { cause: error });
    const safe = auth === "" ? failure.message : failure.message.replaceAll(auth, "[redacted]");
    const diagnostic = classifyError(failure, { phase: "solve", component: "model", secrets: [auth] });
    process.stderr.write(`${diagnostic.code}: ${safe}\n`);
    output({ schemaVersion: 1, type: "error", code: diagnostic.code, message: safe, details: diagnostic.details });
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await startPiRunner();
