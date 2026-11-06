import type { BenchmarkDefinition } from "../benchmark-definition.js";
import { object, required, verificationRecord } from "../records.js";
import { createVerifierContainer, materializeVerifierImage, recoverVerifierContainers } from "../../../../verifiers/shared/container.js";
import { randomUUID } from "node:crypto";

/** Catch BaseException just as human-eval does; exiting is not completing check(). */
export function humanevalProgram(source: string, completionMarker: string): string {
  return `import contextlib, io, json, signal, sys
source = json.loads(${JSON.stringify(JSON.stringify(source))})
write_result = sys.stdout.write
flush_result = sys.stdout.flush
class EvaluationTimeout(BaseException):
    pass
def time_limit(signum, frame):
    raise EvaluationTimeout()
try:
    if hasattr(signal, "setitimer"):
        signal.signal(signal.SIGALRM, time_limit)
        signal.setitimer(signal.ITIMER_REAL, 3)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        exec(source, {})
except EvaluationTimeout:
    signal.setitimer(signal.ITIMER_REAL, 0)
    write_result(${JSON.stringify(completionMarker + ":timeout\n")})
    flush_result()
    sys.exit(1)
except BaseException:
    if hasattr(signal, "setitimer"):
        signal.setitimer(signal.ITIMER_REAL, 0)
    sys.exit(1)
else:
    if hasattr(signal, "setitimer"):
        signal.setitimer(signal.ITIMER_REAL, 0)
    write_result(${JSON.stringify(completionMarker + "\n")})
    flush_result()
`;
}

export const humanEvalRuntime: NonNullable<BenchmarkDefinition["verificationRuntime"]> = ({ dockerExecutable, network }) => ({
  materialize: async (_task, signal) => ({ image: await materializeVerifierImage(dockerExecutable, "python:3.12-slim", signal, network) }),
  recoverAttempts: (keys, signal) => recoverVerifierContainers(dockerExecutable, keys, signal),
  prepare: async (task, receipt, { key, signal }) => {
    const record = verificationRecord(task.verification, "humaneval");
    const signature = required(record.signature, "HumanEval signature");
    const tests = required(record.tests, "HumanEval tests");
    const entryPoint = required(record.entryPoint, "HumanEval entry point");
    const image = required(object(receipt, "HumanEval runtime").image, "HumanEval image");
    const container = await createVerifierContainer(dockerExecutable, image, [
      "--network", "none", "--memory", "256m", "--cpus", "1", "--pids-limit", "64",
      "--read-only", "--tmpfs", "/tmp:size=64m", "--security-opt", "no-new-privileges",
    ], ["python", "-I", "-u", "-"], key, signal);
    return {
      metadata: container.metadata,
      dispose: active => container.dispose(active),
      async verify(result, _environment, active) {
        const timeout = AbortSignal.timeout(30_000);
        const execution = AbortSignal.any([active, timeout]);
        const { worker, done } = container.start(execution);
        let stderr = "";
        let stdout = "";
        worker.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-2000); });
        worker.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
        const completion = result.finalText.match(/```(?:python)?\s*\n([\s\S]+?)```/)?.[1] ?? result.finalText;
        const marker = `HUMANEVAL_COMPLETED_${randomUUID()}`;
        worker.stdin.end(humanevalProgram(`${signature}${completion}\n${tests}\ncheck(${entryPoint})`, marker));
        const code = await done;
        active.throwIfAborted();
        if (code === 125) throw new Error(`HumanEval Docker setup failed: ${stderr.slice(0, 500)}`);
        const timedOut = timeout.aborted || stdout.trim() === `${marker}:timeout`;
        const testsCompleted = stdout.trim() === marker;
        const passed = code === 0 && !timedOut && testsCompleted;
        return { score: passed ? 1 : 0, passed, details: { method: "humaneval", exitCode: code, timedOut, testsCompleted, testTimeoutSeconds: 3 } };
      },
    };
  },
});
