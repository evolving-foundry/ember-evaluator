import type { Selection } from "../contracts/config.js";
import type { JsonValue } from "../contracts/task.js";

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknown(value: Record<string, unknown>, known: readonly string[], path: string): void {
  const allowed = new Set(known);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${path} contains unknown field ${unknown}`);
  }
}

export function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

export function expectPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${path} must be a positive integer greater than zero`);
  }
  return value as number;
}

export function expectPositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive number`);
  }
  return value;
}

export function parseSelection(value: unknown, path: string): Selection {
  const record = expectRecord(value, path);
  rejectUnknown(record, ["name", "config"], path);
  const name = expectNonEmptyString(record.name, `${path}.name`);
  const config = record.config === undefined ? {} : expectRecord(record.config, `${path}.config`);
  return { name, config };
}

export function assertJsonValue(value: unknown, path = "configuration"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} must contain only JSON values`);
}
