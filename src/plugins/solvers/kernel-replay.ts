import type { Solver, AttemptContext } from "../../core/contracts/solver.js";
import type { PublicTask } from "../../core/contracts/task.js";
import type { EnvironmentSession } from "../../core/contracts/environment.js";
import { expectRecord } from "../../core/validation/input.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TrajectoryWriter } from "../../core/artifacts/trajectory.js";

/** 提交 Benchmark 已锁定的候选文件；不调用模型、不修改候选。 */
export class KernelReplaySolver implements Solver {
  requirements() { return []; }
  async solve(input: PublicTask, _session: EnvironmentSession, context: AttemptContext) {
    context.signal.throwIfAborted();
    const payload = expectRecord(input.payload, "kernel replay payload");
    if (typeof payload.candidateSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(payload.candidateSha256))
      throw new TypeError("Missing locked kernel candidate digest");
    const writer = new TrajectoryWriter(join(context.paths.agent, "trajectory.jsonl"), context.key);
    try {
      await writer.append("start", { solver: "kernel-replay" });
      const submission = { operation: "submit-existing-kernel", candidateSha256: payload.candidateSha256, modelCalled: false };
      await writeFile(join(context.paths.agent, "session.jsonl"), JSON.stringify(submission) + "\n");
      await writer.append("end", submission, true);
    } finally { await writer.close(); }
    return { finalText: payload.candidateSha256, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }
}
