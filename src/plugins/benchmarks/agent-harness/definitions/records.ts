import type { JsonValue } from "../../../../core/contracts/task.js";
import type { DefinedTask } from "./benchmark-definition.js";

export type RecordVerification = Record<string, JsonValue>;

export function object(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value;
}

export function required(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

export function strings(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string"))
    throw new TypeError(`${label} must be a string array`);
  return value as string[];
}

export function task(id: string, prompt: string, verification: RecordVerification): DefinedTask {
  if (!prompt.trim()) throw new TypeError("Benchmark prompt is empty");
  return { input: { id, prompt }, verification };
}

/** Reference text for evidence bundles. Hidden tests and empty placeholders stay unpublished. */
export function textualAnswer(verification: JsonValue): JsonValue | null {
  if (verification === null || typeof verification !== "object" || Array.isArray(verification)) return null;
  const expected = verification.expected;
  if (typeof expected !== "string" || expected.trim() === "") return null;
  if (!Array.isArray(verification.aliases)) return expected;
  const aliases = verification.aliases.filter((item): item is string => typeof item === "string");
  return { expected, aliases };
}

export function verificationRecord(value: JsonValue, kind: string): RecordVerification {
  const record = object(value, "Private NeMo verification data");
  if (record.kind !== kind) throw new TypeError(`Expected ${kind} verification data`);
  return record;
}
