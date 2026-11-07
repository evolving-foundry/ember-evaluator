import type { RunIdentity } from "../contracts/result.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function assertRunIdentity(value: unknown): asserts value is RunIdentity {
  const object = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const exact = (item: unknown, keys: string[]) =>
    object(item) &&
    Object.keys(item).length === keys.length &&
    keys.every(key => {
      const field = item[key];
      return nonEmpty(field) && field.length <= 1024;
    });
  if (
    !object(value) ||
    Object.keys(value).length !== 2 ||
    !exact(value.evaluator, ["name", "version"]) ||
    !exact(value.runtime, ["node", "platform", "arch"])
  )
    throw new TypeError("Invalid run identity");
}
