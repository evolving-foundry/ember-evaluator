import type { AttemptRecord, AttemptSummary, RunManifest } from "../contracts/result.js";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { checkedPath } from "../artifacts/artifacts.js";
import { selectAttemptRecords } from "../results/task-result-resolver.js";
import { isEvaluationComplete } from "../results/evaluation-outcome.js";
import { BUILTIN_RUNTIME_ID } from "../results/runtime-identity.js";
import { PACKAGE_RUNTIME_ID } from "../results/runtime-identity.js";

import { ResumeError } from "./resume-error.js";
export type ResumePlan = { skipTaskIds: string[]; restartTaskIds: string[] };

export function assertResumePluginVersions(previous: Record<string, string>, current: Record<string, string>): void {
  const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
  // Evaluator code may change between sessions; external plugins and patch metadata stay locked.
  names.delete(BUILTIN_RUNTIME_ID);
  names.delete(PACKAGE_RUNTIME_ID);
  for (const name of names)
    if (previous[name] !== current[name])
      throw new ResumeError("SOURCE_CHANGED", "Resume plugin versions differ from the original run");
}


export function planResume(run: RunManifest, attempts: AttemptSummary[], configFingerprint: string): ResumePlan {
  if (run.configFingerprint !== configFingerprint)
    throw new ResumeError("SOURCE_CHANGED", "Resume configuration differs from the original run");
  // Completed evaluations (including Agent deadlines) are skipped; invalid, cancelled and
  // uncollected attempts are retried with fresh attempts.
  const completed = new Set(
    selectAttemptRecords(run, attempts)
      .filter(isEvaluationComplete)
      .map(record => record.key.taskId),
  );
  return {
    skipTaskIds: run.taskIds.filter(id => completed.has(id)),
    restartTaskIds: run.taskIds.filter(id => !completed.has(id)),
  };
}

export async function resolveResumeRun(outputRoot: string, requestedRunId: string | null): Promise<string> {
  if (
    requestedRunId !== null &&
    (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(requestedRunId) || requestedRunId.endsWith("."))
  )
    throw new ResumeError("CONFIG_INVALID", "Unsafe resume run ID");
  let root: string;
  try {
    root = await realpath(outputRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ResumeError("CONFIG_INVALID", "No existing run in output directory");
    throw error;
  }
  const candidates: string[] = [];
  for (const name of requestedRunId === null ? await readdir(root) : [requestedRunId]) {
    const directory = join(root, name);
    let stat;
    try {
      stat = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && requestedRunId !== null)
        throw new ResumeError("CONFIG_INVALID", "No existing run matches resume request");
      throw error;
    }
    if (stat.isSymbolicLink()) throw new ResumeError("CONFIG_INVALID", "Resume refuses symlink run directories");
    if (!stat.isDirectory()) continue;
    try {
      const path = await checkedPath(root, `${name}/manifest.json`);
      const run: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!run || typeof run !== "object" || !("runId" in run) || run.runId !== name)
        throw new ResumeError("STORE_RECORD_INVALID", "Run manifest identity differs from directory name");
      candidates.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!candidates.length) throw new ResumeError("CONFIG_INVALID", "No existing run matches resume request");
  if (candidates.length !== 1)
    throw new ResumeError("CONFIG_INVALID", `Multiple runs found; specify a run ID: ${candidates.sort().join(", ")}`);
  return join(root, candidates[0]!);
}
