import type { BenchmarkDefinition } from "./benchmark-definition.js";
import { object, required, task } from "./records.js";
import { scoreHealthBench } from "./scoring/judge.js";

export const healthbenchDefinition: BenchmarkDefinition = {
  name: "healthbench",
  selections: ["test"],
  prepare(id, { value }, index) {
    const row = object(value, `HealthBench row ${index}`);
    const conversation = row.prompt ?? row.conversation;
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = Array.isArray(conversation)
      ? conversation.map((item, position) => {
          const message = object(item, `HealthBench message ${position}`);
          const role = message.role === "assistant" || message.role === "system" ? message.role : "user";
          return { role, content: required(message.content, "HealthBench message content") };
        })
      : [{ role: "user", content: required(conversation, "HealthBench prompt") }];
    const flattened = messages.map(message => `${message.role}: ${message.content}`).join("\n\n");
    return task(id, flattened, {
      kind: "judge",
      conversation: messages,
      expected: "",
      criteria: row.rubrics ?? row.criteria ?? [],
    });
  },
  verify: scoreHealthBench,
};
