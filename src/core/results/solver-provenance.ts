import { posix, win32 } from "node:path";
import type { Solver, SolverProvenance } from "../contracts/solver.js";
import { fingerprintConfig } from "./run-manifest.js";

const secretKey = /(?:api.?key|secret|password|credential|authorization|token)/iu;

export function validateSolverProvenance(value: unknown, secrets: readonly string[] = []): SolverProvenance {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError("Invalid solver provenance");
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 64) throw new TypeError("Invalid solver provenance size");
  for (const [key, item] of entries) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u.test(key) ||
      secretKey.test(key) ||
      typeof item !== "string" ||
      !item ||
      item.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(item) ||
      posix.isAbsolute(item) ||
      win32.isAbsolute(item) ||
      secrets.some(secret => secret !== "" && (item.includes(secret) || item.includes(encodeURIComponent(secret))))
    ) {
      throw new TypeError("Invalid or credential-bearing solver provenance");
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(item)) {
      const url = new URL(item);
      if (url.username || url.password || [...url.searchParams.keys()].some(name => secretKey.test(name)))
        throw new TypeError("Credential-bearing solver provenance URL");
    }
  }
  return Object.fromEntries(entries) as SolverProvenance;
}

export async function resolveSolverProvenance(
  solver: Solver,
  signal: AbortSignal,
  secrets: readonly string[] = [],
  previous?: SolverProvenance,
): Promise<SolverProvenance | undefined> {
  signal.throwIfAborted();
  if (!solver.provenance) return undefined;
  const result = await (previous === undefined ? solver.provenance(signal) : solver.provenance(signal, previous));
  signal.throwIfAborted();
  return validateSolverProvenance(result, secrets);
}

export function assertSolverProvenance(
  expected: SolverProvenance | undefined,
  actual: SolverProvenance | undefined,
): void {
  if (fingerprintConfig(expected ?? null) !== fingerprintConfig(actual ?? null)) {
    throw Object.assign(new Error("SOURCE_CHANGED: candidate or solver runtime differs from the locked run"), {
      code: "SOURCE_CHANGED",
    });
  }
}

function resumeIdentity(value: SolverProvenance | undefined): SolverProvenance | undefined {
  if (value === undefined) return undefined;
  // Installation recipes and the AgentX bridge include Evaluator-owned code.
  // Keep them for runtime caches and worker checks, but allow updates between sessions.
  const { installation: _installation, bridgeDigest: _bridgeDigest, ...identity } = value;
  return identity;
}

export function assertResumeSolverProvenance(
  expected: SolverProvenance | undefined,
  actual: SolverProvenance | undefined,
): void {
  assertSolverProvenance(resumeIdentity(expected), resumeIdentity(actual));
}
