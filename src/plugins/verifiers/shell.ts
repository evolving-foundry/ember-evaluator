import { classifyError } from "../../core/errors/classify.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { readProcess } from "../../infrastructure/process/output.js";
import { checkedPath } from "../../core/artifacts/artifacts.js";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { JsonValue } from "../../core/contracts/task.js";
import type { Verifier, VerificationTask, VerificationEvidence } from "../../core/contracts/verifier.js";

export function parseShellVerifierConfig(value: unknown): Record<string, never> {
  const config = expectRecord(value, "harbor-shell");
  rejectUnknown(config, [], "harbor-shell");
  return {};
}

export function parseRewardEvidence(text: string, format: "json" | "txt"): Record<string, number> {
  const value: unknown = format === "json" ? JSON.parse(text) : Number(text.trim());
  if (format === "txt" && (!text.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text.trim())))
    throw new Error("Invalid numeric reward.txt");
  const rewards = typeof value === "number" ? { reward: value } : expectRecord(value, "reward.json");
  if (!Object.keys(rewards).length || Object.values(rewards).some(value => typeof value !== "number" || !Number.isFinite(value)))
    throw new Error("Harbor rewards must be a non-empty mapping of finite numbers");
  return rewards as Record<string, number>;
}


export class HarborShellVerifier implements Verifier {
  async prepare(task: VerificationTask, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted();
    if (task.importPath !== undefined) throw new Error("Task declares a Python verifier; select a Python Verifier component");
    if (task.stepName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(task.stepName)) throw new TypeError("Invalid verifier step name");
    const testsDirectories: string[] = [];
    const shared = (await lstat(join(task.taskDir, "tests")).catch(() => null))?.isDirectory();
    if (shared) testsDirectories.push(await checkedPath(task.taskDir, "tests"));
    if (task.stepName !== undefined) {
      const relative = `steps/${task.stepName}/tests`;
      const exists = (await lstat(join(task.taskDir, relative)).catch(() => null))?.isDirectory();
      const directory = exists ? await checkedPath(task.taskDir, relative) : undefined;
      if (directory) testsDirectories.push(directory);
      const stepScript = directory && (await lstat(join(directory, "test.sh")).catch(() => null))?.isFile();
      if (!stepScript) await checkedPath(task.taskDir, "tests/test.sh");
    } else await checkedPath(task.taskDir, "tests/test.sh");
    return { ...task, testsDirectories };
  }
  async verify(value: JsonValue, session: EnvironmentSession, signal: AbortSignal): Promise<VerificationEvidence> {
    const envelope = expectRecord(value, "verification");
    const task = expectRecord(envelope.descriptor, "verification.descriptor");
    if (typeof task.taskDir !== "string" || task.timeoutSeconds !== undefined && (typeof task.timeoutSeconds !== "number" || !Number.isFinite(task.timeoutSeconds) || task.timeoutSeconds <= 0)) throw new Error("Invalid shell verification descriptor");
    const active = task.timeoutSeconds === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(task.timeoutSeconds * 1000))]);
    const env = expectRecord(envelope.env ?? {}, "verification.env");
    if (Object.values(env).some(value => typeof value !== "string")) throw new Error("Invalid verifier environment");
    if (envelope.testsInImage !== undefined && typeof envelope.testsInImage !== "boolean") throw new Error("Invalid verification.testsInImage");
    if (envelope.testsInImage !== true) {
      const directories = task.testsDirectories ?? [await checkedPath(task.taskDir, "tests")];
      if (!Array.isArray(directories) || directories.some(value => typeof value !== "string")) throw new TypeError("Invalid shell test directories");
      for (const directory of directories) await session.upload(String(directory), "/tests", active);
    }
    const run = async (command: string, environment: Record<string, string> = {}) => readProcess(await session.start({
      executable: "bash", args: ["-c", command], cwd: session.workdir, env: environment, input: null,
    }, active), active);
    const exit = await run(
      "mkdir -p /logs/verifier && rm -f /logs/verifier/reward.json /logs/verifier/reward.txt && bash /tests/test.sh > /logs/verifier/test-stdout.txt 2> /logs/verifier/test-stderr.txt",
      env as Record<string, string>,
    );
    if (exit.signal !== null) throw new Error(`Verifier was terminated: ${exit.signal}`);
    const reward = await run(
      "if [ -f /logs/verifier/reward.json ]; then f=/logs/verifier/reward.json; fmt=json; elif [ -f /logs/verifier/reward.txt ]; then f=/logs/verifier/reward.txt; fmt=txt; else exit 44; fi; [ $(wc -c < \"$f\") -le 1048576 ] || exit 45; printf '%s\\n' \"$fmt\"; cat -- \"$f\"",
    );
    if (reward.code !== 0 || reward.signal !== null) {
      if (reward.code === 44 && exit.code !== 0) {
        const diagnostic = await run("tail -c 32768 /logs/verifier/test-stderr.txt /logs/verifier/test-stdout.txt");
        const failure = classifyError(new Error(diagnostic.stdout), { phase: "verify" });
        if (failure.code === "NETWORK_FAILURE") throw new EvaluatorError("NETWORK_FAILURE", "Verifier dependency transfer failed before producing reward", failure.details);
      }
      throw new Error(reward.code === 44 ? "Verifier produced no reward file" : "Cannot read verifier reward");
    }
    const newline = reward.stdout.indexOf("\n");
    const format = reward.stdout.slice(0, newline);
    if (newline < 0 || (format !== "json" && format !== "txt")) throw new Error("Invalid reward retrieval protocol");
    return { rewards: parseRewardEvidence(reward.stdout.slice(newline + 1), format),
      details: { format, exitCode: exit.code, scoreFile: `verifier/reward.${format}`, scoring: "task-native" } };
  }
}
