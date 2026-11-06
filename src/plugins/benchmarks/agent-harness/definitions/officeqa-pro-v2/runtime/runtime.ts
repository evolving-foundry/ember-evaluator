import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { VerificationRuntime } from "../../../../../../core/contracts/verification-runtime.js";
import { expectNonEmptyString, expectRecord } from "../../../../../../core/validation/input.js";
import { createVerifierContainer, materializeVerifierImage, recoverVerifierContainers } from "../../../../../verifiers/shared/container.js";

export const OFFICEQA_REWARD_REVISION = "7b9a3c154ef9fb40215bb67934afc43e6799de16";
export const OFFICEQA_REWARD_SHA256 = "0d91698c87df6d889339aac36f63ae0966607f169890b0bf8b472b26bfe8138f";

/** Run the unchanged upstream scorer; private inputs travel through stdin, never argv. */
export async function officeQAScoringProgram(): Promise<string> {
  const source = await readFile(new URL("./reward.py", import.meta.url), "utf8");
  if (createHash("sha256").update(source).digest("hex") !== OFFICEQA_REWARD_SHA256)
    throw new Error("OfficeQA reference scorer checksum mismatch");
  return `${source}\nimport json, sys\nrequest = json.load(sys.stdin)\nprint(json.dumps({"score": score_answer(request["answer"], request["prediction"], request["tolerance"])}))\n`;
}

export function officeQAVerificationRuntime(docker: string, network?: import("../../../../../../core/contracts/network.js").NetworkAccess): VerificationRuntime {
  return {
    materialize: async (_task, signal) => ({ image: await materializeVerifierImage(docker, "python:3.12-slim", signal, network) }),
    recoverAttempts: (keys, signal) => recoverVerifierContainers(docker, keys, signal),
    async prepare(task, receipt, { key, signal }) {
      const verification = expectRecord(task.verification, "OfficeQA verification");
      const answer = expectNonEmptyString(verification.answer, "OfficeQA answer");
      const tolerance = verification.tolerance;
      const corpusFormat = verification.corpusFormat;
      if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1 ||
        (corpusFormat !== "parsed-json" && corpusFormat !== "pdf")) throw new TypeError("Invalid OfficeQA verification parameters");
      const image = expectNonEmptyString(expectRecord(receipt, "OfficeQA runtime").image, "OfficeQA verifier image");
      const program = await officeQAScoringProgram();
      const container = await createVerifierContainer(docker, image, ["--network", "none", "--memory", "256m", "--cpus", "1",
        "--pids-limit", "64", "--read-only", "--tmpfs", "/tmp:size=16m", "--security-opt", "no-new-privileges"], ["python", "-c", program], key, signal);
      return {
        metadata: { ...container.metadata, scorerRevision: OFFICEQA_REWARD_REVISION, scorerSha256: OFFICEQA_REWARD_SHA256 },
        dispose: active => container.dispose(active),
        async verify(result, _environment, active) {
          const timeout = AbortSignal.timeout(30_000);
          const execution = AbortSignal.any([active, timeout]);
          const { worker, done } = container.start(execution);
          let stdout = "", stderr = "", oversized = false;
          worker.stdout.on("data", chunk => {
            if (stdout.length + String(chunk).length > 4096) oversized = true;
            else stdout += String(chunk);
          });
          worker.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
          worker.stdin.end(JSON.stringify({ answer, prediction: result.finalText, tolerance }));
          const code = await done;
          execution.throwIfAborted();
          if (code !== 0 || oversized) throw new Error(`OfficeQA scoring process failed (exit ${code}): ${stderr}`);
          const evidence: unknown = JSON.parse(stdout);
          const score = expectRecord(evidence, "OfficeQA scoring output").score;
          if (score !== 0 && score !== 1) throw new Error("Invalid OfficeQA scoring output");
          return { score, passed: score === 1, details: { method: "officeqa-pro-v2", scorerRevision: OFFICEQA_REWARD_REVISION,
            scorerSha256: OFFICEQA_REWARD_SHA256, tolerance, corpusFormat } };
        },
      };
    },
  };
}
