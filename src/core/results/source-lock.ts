import type { JsonValue, SourceLock } from "../contracts/task.js";

const SHA256 = /^[a-f0-9]{64}$/u;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], path: string): void {
  const keys = Reflect.ownKeys(value);
  const invalid = keys.find(key => typeof key !== "string" || !fields.includes(key));
  if (invalid !== undefined) throw new TypeError(`${path} contains unknown field ${String(invalid)}`);
  const missing = fields.find(field => !Object.hasOwn(value, field));
  if (missing !== undefined) throw new TypeError(`${path} is missing ${missing}`);
}

function text(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${path} must be a bounded non-empty string`);
  }
  return value;
}

function assertJson(value: unknown, path: string, ancestors: Set<object>, depth: number): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new TypeError(`${path} must contain only JSON values`);
  if (depth > 100) throw new TypeError(`${path} exceeds the JSON nesting limit`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError(`${path} must not contain sparse array entries`);
        assertJson(value[index], `${path}[${index}]`, ancestors, depth + 1);
      }
      return;
    }
    const object = record(value, path);
    if (Reflect.ownKeys(object).some(key => typeof key !== "string"))
      throw new TypeError(`${path} must contain only string keys`);
    for (const [key, item] of Object.entries(object)) assertJson(item, `${path}.${key}`, ancestors, depth + 1);
  } finally {
    ancestors.delete(value);
  }
}

/** Validate the source identity stored in a run before it can be trusted by resume. */
export function assertSourceLock(value: unknown): asserts value is SourceLock {
  const lock = record(value, "source lock");
  exact(lock, ["source", "revision", "files", "metadata"], "source lock");
  text(lock.source, "source lock.source", 4096);
  // Revisions are source-defined opaque identifiers (for example a git SHA or
  // a content digest), so only their JSON/string bounds are enforced here.
  text(lock.revision, "source lock.revision", 4096);
  if (!Array.isArray(lock.files) || lock.files.length > 100_000)
    throw new TypeError("source lock.files must be a bounded array");
  const paths = new Set<string>();
  for (const [index, item] of lock.files.entries()) {
    const file = record(item, `source lock.files[${index}]`);
    exact(file, ["path", "sha256", "origin"], `source lock.files[${index}]`);
    const path = text(file.path, `source lock.files[${index}].path`, 4096);
    if (paths.has(path)) throw new TypeError(`source lock.files[${index}].path is duplicated`);
    paths.add(path);
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256))
      throw new TypeError(`source lock.files[${index}].sha256 must be a lowercase SHA-256 digest`);
    text(file.origin, `source lock.files[${index}].origin`, 16_384);
  }
  assertJson(lock.metadata, "source lock.metadata", new Set(), 0);
}
