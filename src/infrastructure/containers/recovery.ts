import type { AttemptKey } from "../../core/contracts/result.js";
import type { DockerCommand } from "./runtime-contract.js";

/** The three allocation labels jointly identify resources; never prune by name. */
export async function recoverDockerAttempts(
  command: DockerCommand,
  keys: AttemptKey[],
  signal: AbortSignal,
): Promise<void> {
  for (const key of keys) {
    signal.throwIfAborted();
    const labels = {
      "ember.run": key.runId,
      "ember.task": key.taskId,
      "ember.attempt": key.attemptId,
    };
    const expected = Object.fromEntries(
      Object.entries(labels).map(([name, value]) => [name, value.replace(/[\u0000-\u001f\u007f]/gu, "_")]),
    );
    const output = await command(
      [
        "ps",
        "--all",
        "--quiet",
        ...Object.entries(expected).flatMap(([name, value]) => ["--filter", `label=${name}=${value}`]),
      ],
      { signal },
    );
    const ids = output.stdout.trim().split(/\s+/u).filter(Boolean);
    for (const id of ids) {
      if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error("Invalid Docker container identity during recovery");
      const inspected = JSON.parse((await command(["inspect", id], { signal })).stdout) as {
        Config?: { Labels?: Record<string, string> };
      }[];
      const actual = inspected[0]?.Config?.Labels;
      if (
        !actual ||
        Object.entries(expected).some(([name, value]) => actual[name] !== value) ||
        !["solve", "verify"].includes(actual["ember.phase"] ?? "")
      )
        throw new Error("Docker recovery label identity changed");
      await command(["rm", "--force", id], { signal });
    }
  }
}
