
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { ModelConfig, RuntimeAuth } from "../../core/contracts/config.js";

import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { AttemptContext, PreparedSolver } from "../../core/contracts/solver.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { JsonValue, PublicTask } from "../../core/contracts/task.js";
import { canonicalJson } from "../../core/results/run-manifest.js";
import { AgentBundleError, type VerifiedBundle } from "./cli.js";


export function sameCandidate(expected: VerifiedBundle, actual: VerifiedBundle): void {
  if (expected.digest !== actual.digest || canonicalJson(expected.harness) !== canonicalJson(actual.harness)) {
    throw new AgentBundleError("SOURCE_CHANGED", "CLI candidate identity or harness changed");
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function customHomeDirectory(home: string): Promise<string> {
  if (!isAbsolute(home)) throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "agentbundle home must be resolved to an absolute path");
  await mkdir(home, { recursive: true });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "agentbundle home must be a regular directory");
  return realpath(home);
}

export async function writeHomeConfig(target: string, content: string): Promise<void> {
  const info = await lstat(target).catch(error => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  if (info && (!info.isFile() || info.isSymbolicLink()))
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "agentbundle configuration target must be a regular file");
  await writeFile(target, content, { mode: 0o600 });
}

export async function claimPersistentState(stateRoot: string, state: string, identity: string): Promise<string> {
  await mkdir(state, { recursive: true });
  const info = await lstat(state);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "agentbundle state directory is not a regular directory");
  const [root, actual] = await Promise.all([realpath(stateRoot), realpath(state)]);
  const relation = relative(root, actual);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "agentbundle state directory escaped the runtime state root");
  }
  const marker = join(actual, ".identity");
  let stored = identity;
  try {
    await writeFile(marker, identity, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const markerInfo = await lstat(marker);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink())
      throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "agentbundle state identity marker is not a regular file");
    stored = await readFile(marker, "utf8");
  }
  if (stored !== identity)
    throw new AgentBundleError(
      "SOURCE_CHANGED",
      "agentbundle state prefix belongs to a different full identity",
    );
  return actual;
}

export type BundlePreparation = {
  network?: import("../../core/contracts/network.js").NetworkAccess | undefined;
  path: string;
  model: ModelConfig;
  auth: RuntimeAuth;
  options: {
    environmentName?: string; dshhome?: string; dshprofile?: string; hermeshome?: string;
    jiuwenswarmhome?: string; jiuwenswarmTimeoutSeconds?: number;
    pi?: { settings?: Record<string, JsonValue> };
  };
  harnessVersion: string | undefined;
};
export function preparedAttempt(
  release: () => Promise<void>,
  start: (input: PublicTask, signal: AbortSignal) => Promise<ProcessHandle>,
  consume: (handle: ProcessHandle, context: AttemptContext, signal: AbortSignal, input: PublicTask) => Promise<SolveResult>,
): PreparedSolver {
  const controller = new AbortController();
  let flight: Promise<SolveResult> | undefined;
  let disposed = false;
  let cleanup: Promise<void> | undefined;
  return {
    solve: (input, solveContext) => {
      if (disposed || flight)
        return Promise.reject(
          new AgentBundleError("SOLVER_PROTOCOL_INVALID", "prepared attempt is already used or disposed"),
        );
      const signal = AbortSignal.any([controller.signal, solveContext.signal]);
      flight = (async () => {
        signal.throwIfAborted();
        const handle = await start(input, signal);
        return consume(handle, solveContext, signal, input);
      })();
      return flight;
    },
    dispose: async signal => {
      disposed = true;
      controller.abort();
      const completion = (cleanup ??= (async () => {
        if (flight) await flight.catch(() => {});
        await release();
      })());
      // A cancelled cleanup stops waiting, but never unlocks a home while
      // its process may still be writing; eventual completion releases it.
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        completion.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    },
  };
}
