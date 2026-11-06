import type { BashOperations } from "@earendil-works/pi-coding-agent";

/**
 * Evaluator-level shell guard rail: a single runaway command (for example a
 * filesystem-wide grep reaching /proc) must consume at most one bounded
 * timeout, never an entire solve phase. The underlying shell operations
 * terminate the whole process tree on expiry and surface the timeout to the
 * model as an ordinary tool result, so the agent can recover and continue
 * instead of losing the attempt.
 */
export type ShellToolPolicy = {
  /** Applied when a tool call does not request its own timeout. */
  shellTimeoutSeconds: number;
  /** Model-requested timeouts are clamped to this ceiling. */
  shellMaxTimeoutSeconds: number;
};

export const DEFAULT_SHELL_TOOL_POLICY: ShellToolPolicy = {
  shellTimeoutSeconds: 180,
  shellMaxTimeoutSeconds: 600,
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseShellToolPolicy(value: unknown, path: string): ShellToolPolicy {
  const source = record(value, path);
  const unknown = Object.keys(source).find(key => key !== "shellTimeoutSeconds" && key !== "shellMaxTimeoutSeconds");
  if (unknown !== undefined) throw new TypeError(`${path} contains unknown field ${unknown}`);
  const seconds = (field: "shellTimeoutSeconds" | "shellMaxTimeoutSeconds"): number => {
    const raw = source[field];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw new TypeError(`${path}.${field} must be a positive number`);
    }
    return raw;
  };
  const shellTimeoutSeconds = seconds("shellTimeoutSeconds");
  const shellMaxTimeoutSeconds = seconds("shellMaxTimeoutSeconds");
  if (shellMaxTimeoutSeconds < shellTimeoutSeconds) {
    throw new TypeError(`${path}.shellMaxTimeoutSeconds must not be lower than shellTimeoutSeconds`);
  }
  return { shellTimeoutSeconds, shellMaxTimeoutSeconds };
}

export function resolveShellTimeout(requested: number | undefined, policy: ShellToolPolicy): number {
  return Math.min(requested ?? policy.shellTimeoutSeconds, policy.shellMaxTimeoutSeconds);
}

export function enforceShellTimeout(operations: BashOperations, policy: ShellToolPolicy): BashOperations {
  return {
    exec: (command, cwd, options) =>
      operations.exec(command, cwd, { ...options, timeout: resolveShellTimeout(options.timeout, policy) }),
  };
}
