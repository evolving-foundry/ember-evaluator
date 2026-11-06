import { writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { expectNonEmptyString, expectPositiveNumber, expectRecord, rejectUnknown } from "../../core/validation/input.js";
import type { EnvironmentSession, RuntimeInstallation, RuntimeRequirement } from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext, PreparedSolver, Solver, SolverProvenance } from "../../core/contracts/solver.js";
import type { PublicTask } from "../../core/contracts/task.js";
import { bindSolverService, type ServiceBinding, type PluginFactoryContext } from "../../core/contracts/plugin.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { StringDecoder } from "node:string_decoder";
import { AGENTX_VERSION } from "../../runtimes/agentx/versions.js";
import { agentXUsage, normalizeAgentXExport, parseWorkload } from "../benchmarks/inference-engine/agentx/evidence/summary.js";
import { normalizeTelemetry, parseTelemetryConfig, type AgentXTelemetryConfig } from "../benchmarks/inference-engine/agentx/evidence/telemetry.js";
import { agentXBridgeDigest, agentXLocalInstallation, lockAgentXLexicon, resolveAgentXPython, type AgentXLexicon } from "../../runtimes/agentx/runtime.js";
import { startHostTelemetry, type HostNpuSampling } from "../../runtimes/agentx/host-telemetry.js";
import { parseNetworkLatencyConfig, type AgentXNetworkLatencyConfig } from "../benchmarks/inference-engine/agentx/evidence/network-latency.js";

export type AgentXReplayConfig = {
  tokenizer?: string;
  tokenizerRevision?: string;
  trustRemoteCode: boolean;
  pythonExecutable?: string;
  cacheDir: string;
  requestTimeoutSeconds?: number;
  telemetry?: AgentXTelemetryConfig;
  networkLatency?: AgentXNetworkLatencyConfig;
};

export function parseAgentXReplayConfig(value: unknown): AgentXReplayConfig {
  const v = expectRecord(value, "agentx-replay");
  rejectUnknown(v, ["tokenizer", "tokenizerRevision", "trustRemoteCode", "pythonExecutable", "cacheDir", "requestTimeoutSeconds", "telemetry", "networkLatency"], "agentx-replay");
  if (v.trustRemoteCode !== undefined && typeof v.trustRemoteCode !== "boolean") throw new TypeError("agentx-replay.trustRemoteCode must be boolean");
  return { trustRemoteCode: v.trustRemoteCode === true,
    cacheDir: expectNonEmptyString(v.cacheDir ?? ".cache/agentx", "agentx-replay.cacheDir"),
    ...(v.telemetry === undefined ? {} : { telemetry: parseTelemetryConfig(v.telemetry) }),
    ...(v.networkLatency === undefined ? {} : { networkLatency: parseNetworkLatencyConfig(v.networkLatency) }),
    ...(v.tokenizer === undefined ? {} : { tokenizer: expectNonEmptyString(v.tokenizer, "agentx-replay.tokenizer") }),
    ...(v.tokenizerRevision === undefined ? {} : { tokenizerRevision: expectNonEmptyString(v.tokenizerRevision, "agentx-replay.tokenizerRevision") }),
    ...(v.pythonExecutable === undefined ? {} : { pythonExecutable: expectNonEmptyString(v.pythonExecutable, "agentx-replay.pythonExecutable") }),
    ...(v.requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds: expectPositiveNumber(v.requestTimeoutSeconds, "agentx-replay.requestTimeoutSeconds") }) };
}

export function agentXEndpoint(endpoint: string): { url: string; endpoint: string } {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new TypeError("AgentX endpoint must be a credential-free HTTP(S) URL");
  const path = url.pathname.replace(/\/+$/u, "");
  return { url: url.origin, endpoint: path.endsWith("/chat/completions") ? path : `${path || "/v1"}/chat/completions` };
}

async function collect(stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maxBytes) throw new Error("AgentX bridge output exceeded its protocol limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class AgentXReplaySolver implements Solver {
  readonly runtimeInstallation?: (signal: AbortSignal) => Promise<RuntimeInstallation>;
  private readonly binding: ServiceBinding;
  private lexicon: Promise<AgentXLexicon> | undefined;
  constructor(private readonly config: AgentXReplayConfig, private readonly runtime: PluginFactoryContext) {
    if (config.telemetry) parseTelemetryConfig(config.telemetry, runtime.hardware);
    this.binding = bindSolverService(runtime);
    if (config.telemetry?.ascend && "mode" in config.telemetry.ascend && !["local", "docker"].includes(runtime.environmentName ?? ""))
      throw new TypeError("Local Ascend telemetry requires a local Docker host or local environment");
    if (this.binding.model.endpoint === null || this.binding.model.api !== "openai-completions")
      throw new TypeError("agentx-replay requires OpenAI Chat Completions");
    agentXEndpoint(this.binding.model.endpoint);
    if (runtime.environmentName === "local")
      this.runtimeInstallation = signal => agentXLocalInstallation(config.pythonExecutable, signal);
  }
  requirements(): RuntimeRequirement[] { return []; }

  private vocabulary(signal: AbortSignal, previous?: SolverProvenance): Promise<AgentXLexicon> {
    return this.lexicon ??= lockAgentXLexicon(this.config.tokenizer ?? this.binding.model.name, this.config.tokenizerRevision,
      this.runtime.resolvePath(this.config.cacheDir), this.runtime.resolvePath, signal, previous, this.runtime.network);
  }

  async provenance(signal: AbortSignal, previous?: SolverProvenance): Promise<SolverProvenance> {
    const lexicon = await this.vocabulary(signal, previous);
    const pythonVersion = this.runtime.environmentName === "local" ? (await resolveAgentXPython(this.config.pythonExecutable, signal)).version : "3.12.14";
    return { harnessVersion: AGENTX_VERSION, bridgeDigest: await agentXBridgeDigest(signal), pythonVersion,
      lexiconSource: lexicon.source, lexiconRevision: lexicon.revision, lexiconDigest: lexicon.digest };
  }

  async prepare(session: EnvironmentSession, context: AttemptContext): Promise<PreparedSolver> {
    const lexicon = await this.vocabulary(context.signal);
    await session.upload(lexicon.path, "agentx-tokenizer", context.signal);
    const local = this.runtime.environmentName === "local";
    if (local && !session.runtime) throw new Error("AgentX local runtime was not installed");
    const root = session.runtime?.root;
    const python = local && root ? join(root, "venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python")
      : "/opt/agentx/bin/python";
    const runner = local && root ? join(root, "bridge", "runner.py") : "/opt/agentx-bridge/runner.py";
    return { solve: (input, active) => this.execute(input, session, python, runner, lexicon, active) };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    return await (await this.prepare(session, context)).solve(input, context);
  }

  private async execute(input: PublicTask, session: EnvironmentSession, python: string, runner: string,
    lexicon: AgentXLexicon, context: AttemptContext): Promise<SolveResult> {
    parseWorkload(input.payload);
    const ascend = this.config.telemetry?.ascend;
    let sampling: HostNpuSampling | undefined;
    if (ascend && "mode" in ascend) {
      context.activity?.({ message: "Starting read-only NPU sampling on the host", activity: true });
      sampling = await startHostTelemetry(ascend.devices, join(context.paths.agent, "host-telemetry"), context.signal,
        this.runtime.environmentName === "local" ? python : undefined);
    }
    try { return await this.executeMeasurement(input, session, python, runner, lexicon, context, sampling); }
    finally {
      if (sampling) await writeFile(join(context.paths.agent, "host-telemetry.json"),
        JSON.stringify({ localAscend: await sampling.finish() }, null, 2) + "\n", "utf8");
    }
  }

  private async executeMeasurement(input: PublicTask, session: EnvironmentSession, python: string, runner: string,
    lexicon: AgentXLexicon, context: AttemptContext, sampling?: HostNpuSampling): Promise<SolveResult> {
    const workload = parseWorkload(input.payload);
    const base = session.modelEndpoint?.baseUrl ?? this.binding.model.endpoint;
    if (base === null) throw new TypeError("Missing AgentX endpoint");
    const endpoint = agentXEndpoint(base);
    const tokenizerPath = this.runtime.environmentName === "local" ? join(session.workdir, "agentx-tokenizer") : posix.join(session.workdir, "agentx-tokenizer");
    const request = { schemaVersion: 1, key: context.key, workload, ...endpoint,
      ...(this.config.networkLatency === undefined ? {} : { networkLatency: this.config.networkLatency }),
      ...(this.config.telemetry === undefined ? {} : { telemetry: this.config.telemetry }),
      ...(sampling ? { hostAscend: sampling.targets } : {}),
      model: this.binding.model.name, auth: this.binding.auth, tokenizerPath, trustRemoteCode: this.config.trustRemoteCode,
      artifactDir: this.runtime.environmentName === "local" ? join(session.workdir, "agentx-artifacts") : posix.join(session.workdir, "agentx-artifacts"),
      outputDir: session.agentOutputDir, ...(this.config.requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds: this.config.requestTimeoutSeconds }) };
    const handle = await session.start({ executable: python, args: [runner], cwd: session.workdir,
      env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, input: Buffer.from(JSON.stringify(request)) }, context.signal);
    try {
      const observedOutput = async () => {
        const decoder = new StringDecoder("utf8");
        let pending = ""; let terminal = "";
        for await (const chunk of handle.stdout) {
          pending += decoder.write(Buffer.from(chunk));
          if (pending.length > 16 * 1024 * 1024) throw new TypeError("AgentX output exceeds protocol limit");
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            const value: unknown = JSON.parse(line);
            if (value && typeof value === "object" && "type" in value && value.type === "activity") {
              if ("message" in value && value.message === "AgentX: harness output received") context.activity?.({ message: "AgentX is running; harness activity received" });
            } else {
              if (terminal) throw new TypeError("Multiple AgentX terminal messages");
              terminal = line;
            }
          }
        }
        pending += decoder.end();
        if (pending.trim()) { if (terminal) throw new TypeError("Multiple AgentX terminal messages"); terminal = pending; }
        return terminal;
      };
      const [stdout, stderr, exit] = await Promise.all([observedOutput(), collect(handle.stderr, 1024 * 1024), handle.done]);
      await writeFile(join(context.paths.agent, "bridge-stderr.log"), redactDiagnostic(stderr, [this.binding.auth.value]), "utf8");
      context.signal.throwIfAborted();
      if (exit.code !== 0 || exit.signal !== null) throw new Error("AgentX Harness failed; see collected Harness artifacts and bridge-stderr.log");
      const lines = stdout.trim().split(/\r?\n/u);
      if (lines.length !== 1) throw new TypeError("Malformed AgentX terminal protocol");
      const terminal = expectRecord(JSON.parse(lines[0] ?? ""), "AgentX terminal result");
      if (terminal.schemaVersion !== 1 || terminal.type !== "result") throw new TypeError("AgentX bridge returned no measurement");
      const summary = normalizeAgentXExport(terminal.export, workload, { source: lexicon.source, revision: lexicon.revision, digest: lexicon.digest }, terminal.replayCoverage,
        this.config.networkLatency === undefined ? undefined : { config: this.config.networkLatency, probes: terminal.networkLatencyProbes });
      let telemetry = terminal.telemetry;
      if (sampling) telemetry = { ...expectRecord(telemetry, "host telemetry evidence"), localAscend: await sampling.finish() };
      if (this.config.telemetry) summary.telemetry = normalizeTelemetry(this.config.telemetry, this.binding.model.name, telemetry);
      await writeFile(join(context.paths.agent, "agentx-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
      return { finalText: `AgentX completed at ${workload.concurrency} concurrent session trees`, usage: agentXUsage(summary), observations: summary };
    } catch (error) {
      await handle.stop(500);
      throw error;
    }
  }
}
