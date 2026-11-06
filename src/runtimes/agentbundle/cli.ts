import type { ErrorCode } from "../../core/errors/registry.js";
import type { CommandSpec, ProcessHandle } from "../../core/contracts/environment.js";
import { expectNonEmptyString, expectRecord } from "../../core/validation/input.js";

export class AgentBundleError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "AgentBundleError";
  }
}

export type VerifiedBundle = {
  digest: string;
  harness: { name: string; versionRange: string; actualVersion?: string };
};
export type InstalledBundle = VerifiedBundle & {
  home: string;
  profile: string;
  reused: boolean;
  installationId: string;
  codingAgentDir?: string;
};

// These are CLI response fields, not AgentBundle manifest/schema definitions.
// `actualVersion` is only echoed when the caller passed --harness-version; the
// solver enforces its presence after the version-pinning verify call.
export function parseVerifiedBundle(value: unknown): VerifiedBundle {
  const record = expectRecord(value, "AgentBundle response");
  const harness = expectRecord(record.harness, "AgentBundle response.harness (upgrade the CLI if missing)");
  return {
    digest: expectNonEmptyString(record.digest, "AgentBundle response.digest"),
    harness: {
      name: expectNonEmptyString(harness.name, "AgentBundle response.harness.name"),
      versionRange: expectNonEmptyString(harness.versionRange, "AgentBundle response.harness.versionRange"),
      ...(harness.actualVersion === undefined
        ? {}
        : { actualVersion: expectNonEmptyString(harness.actualVersion, "AgentBundle response.harness.actualVersion") }),
    },
  };
}

export function parseInstalledBundle(value: unknown): InstalledBundle {
  const verified = parseVerifiedBundle(value);
  const record = expectRecord(value, "AgentBundle install response");
  if (typeof record.reused !== "boolean") throw new TypeError("AgentBundle install response.reused must be boolean");
  return {
    ...verified,
    reused: record.reused,
    home: expectNonEmptyString(record.home, "AgentBundle install response.home"),
    profile: expectNonEmptyString(record.profile, "AgentBundle install response.profile"),
    installationId: expectNonEmptyString(record.installationId, "AgentBundle install response.installationId"),
    ...(record["coding-agent-dir"] === undefined
      ? {}
      : { codingAgentDir: expectNonEmptyString(record["coding-agent-dir"], "AgentBundle install response.coding-agent-dir") }),
  };
}

export type StartCommand = (command: CommandSpec, signal: AbortSignal) => Promise<ProcessHandle>;

export async function cliOutput(start: StartCommand, command: CommandSpec, signal: AbortSignal): Promise<string> {
  const handle = await start(command, signal);
  async function collect(stream: AsyncIterable<Uint8Array>, maximum: number): Promise<string> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const bytes of stream) {
      length += bytes.byteLength;
      if (length > maximum) throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "CLI output exceeded its size limit");
      chunks.push(Buffer.from(bytes));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const stdout = collect(handle.stdout, 1024 * 1024);
  const stderr = collect(handle.stderr, 1024 * 1024);
  try {
    const [out, diagnostic, exit] = await Promise.all([stdout, stderr, handle.done]);
    signal.throwIfAborted();
    if (exit.code !== 0 || exit.signal !== null)
      throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", diagnostic.trim() || `CLI exited ${exit.code ?? exit.signal}`);
    return out;
  } catch (error) {
    await handle.stop(100).catch(() => {});
    await Promise.allSettled([stdout, stderr, handle.done]);
    signal.throwIfAborted();
    throw error;
  }
}

export async function cliJson(start: StartCommand, command: CommandSpec, signal: AbortSignal): Promise<unknown> {
  const text = await cliOutput(start, command, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "CLI did not return one JSON response", { cause });
  }
}
