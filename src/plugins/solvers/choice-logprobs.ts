import type { Solver, AttemptContext } from "../../core/contracts/solver.js";
import type { PublicTask, JsonValue } from "../../core/contracts/task.js";
import type { EnvironmentSession, RuntimeRequirement } from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { ModelConfig, RuntimeAuth } from "../../core/contracts/config.js";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { redactEvidence, formatError } from "../../core/errors/diagnostics.js";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chatLogprobsEndpoint, requestChatLogprobs, type ChatLogprobsParameters } from "../../infrastructure/models/chat-logprobs.js";

export function parseChoiceLogprobsConfig(value: unknown): ChatLogprobsParameters {
  const config = expectRecord(value, "choice-logprobs");
  rejectUnknown(config, ["topLogprobs", "thinking"], "choice-logprobs");
  const topLogprobs = config.topLogprobs ?? 20;
  if (typeof topLogprobs !== "number" || !Number.isInteger(topLogprobs) || topLogprobs < 1 || topLogprobs > 20)
    throw new TypeError("choice-logprobs.topLogprobs must be an integer between 1 and 20");
  const thinking = config.thinking ?? "omit";
  if (thinking !== "disabled" && thinking !== "omit") throw new TypeError("choice-logprobs.thinking must be disabled or omit");
  return { topLogprobs, thinking };
}

export class ChoiceLogprobsSolver implements Solver {
  constructor(private readonly config: ChatLogprobsParameters, private readonly model: ModelConfig, private readonly auth: RuntimeAuth,
    environmentName: string | undefined) {
    if (environmentName !== "local") throw new TypeError("choice-logprobs requires environment: local; requests execute in the worker process");
    if (model.endpoint === null || model.api !== "openai-completions") throw new TypeError("choice-logprobs requires an explicit OpenAI Chat Completions service");
    chatLogprobsEndpoint(model.endpoint);
  }
  requirements(): RuntimeRequirement[] { return []; }
  async solve(input: PublicTask, _session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    context.signal.throwIfAborted();
    await mkdir(context.paths.agent, { recursive: true });
    let sequence = 0;
    const append = async (type: string, data: JsonValue) => {
      const event = { schemaVersion: 1, key: context.key, seq: ++sequence, at: new Date().toISOString(), type,
        data: redactEvidence(data, [this.auth.value]) };
      const line = JSON.stringify(event) + "\n";
      // This solver makes one sequential request, so no streaming queue is needed.
      for (const name of ["trajectory.jsonl", "session.jsonl"])
        await appendFile(join(context.paths.agent, name), line, { encoding: "utf8", mode: 0o600, flush: type === "end" });
    };
    await append("start", { taskId: input.id, prompt: input.prompt, model: this.model.name, parameters: this.config });
    context.activity?.({ message: "Requesting answer token log probabilities", lines: [] });
    try {
      const result = await requestChatLogprobs(this.model, this.auth, input.prompt, this.config, context.signal);
      const finalText = this.auth.value ? result.text.replaceAll(this.auth.value, "[redacted]") : result.text;
      const observations = redactEvidence(result.evidence, [this.auth.value]);
      await append("message", { role: "assistant", content: result.text, observations });
      await append("usage", { ...result.usage });
      await append("end", { status: "completed", finalText });
      return { finalText, usage: result.usage, observations };
    } catch (error) {
      try {
        await append("error", { message: formatError(error, [this.auth.value]) });
        await append("end", { status: "failed" });
      } catch (recordingError) {
        throw new AggregateError([error, recordingError], "Probability request failed and its trajectory could not be recorded");
      }
      throw error;
    }
  }
}
