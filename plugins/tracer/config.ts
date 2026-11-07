import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TracerConfig = {
  /** Collector base URL, without a trailing slash. */
  url: string;
  /** Path to the Collector entrypoint (main.js, or main.ts in a source checkout); relative paths await resolveTracerConfig. */
  collector: string;
  /** Persistent SQLite database; relative paths await resolveTracerConfig. */
  db: string;
  /** Persistent spool directory; relative paths await resolveTracerConfig. */
  spool: string;
  /** Optional Bearer token for the Collector write APIs. */
  token: string;
  /** Start the Collector when no healthy process is reachable. */
  autostart: boolean;
  /** Health probe and startup budget. */
  timeoutMs: number;
};

/** Plugin root: `plugins/tracer/` in a source checkout, the packaged `dist/` directory after a build. */
const PLUGIN_ROOT = fileURLToPath(new URL(".", import.meta.url));
/** Repository root, shared by the source and the dist layout. */
const PACKAGE_ROOT = process.cwd();
const COLLECTOR_ENTRY = [resolve(PLUGIN_ROOT, "collector", "main.js"), resolve(PLUGIN_ROOT, "collector", "main.ts")]
  .find(path => existsSync(path)) ?? resolve(PLUGIN_ROOT, "collector", "main.js");
/** Node loader that lets a TypeScript Collector start without a build. */
const SOURCE_LOADER = resolve(PLUGIN_ROOT, "..", "..", "scripts", "source-loader.mjs");
const DATA_ROOT = resolve(PACKAGE_ROOT, ".cache", "tracer");
const KNOWN_FIELDS = ["url", "collector", "db", "spool", "token", "tokenEnv", "autostart", "timeoutMs"];

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

/** Options saved with a run must never contain a literal credential. */
export function parseTracerOptions(value: unknown): Record<string, import("ember-evaluator").JsonValue> {
  const record = expectRecord(value ?? {}, "tracer options");
  const allowed = ["url", "collector", "db", "spool", "tokenEnv", "autostart", "timeoutMs"];
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new TypeError(`Unknown tracer option ${key}; use tokenEnv for credentials`);
  if (record.tokenEnv !== undefined && (typeof record.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(record.tokenEnv))) throw new TypeError("Invalid tracer.tokenEnv");
  if (typeof record.url === "string") {
    const url = new URL(record.url);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new TypeError("tracer.url must be a credential-free HTTP(S) origin");
  }
  const { tokenEnv, ...options } = record;
  parseTracerConfig(options);
  return { ...options, ...(tokenEnv === undefined ? {} : { tokenEnv }) } as Record<string, import("ember-evaluator").JsonValue>;
}

export function parseTracerConfig(value: unknown): TracerConfig {
  const record = expectRecord(value ?? {}, "tracer store config");
  const unknown = Object.keys(record).find(key => !KNOWN_FIELDS.includes(key));
  if (unknown !== undefined) throw new TypeError(`tracer store config contains unknown field ${unknown}`);

  const rawUrl = optionalString(record.url, "tracer.url") ?? process.env.TRACER_URL ?? "http://127.0.0.1:8787";
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TypeError(`tracer.url must be an absolute http(s) URL, got ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("tracer.url must use http or https");
  }

  const collector = optionalString(record.collector, "tracer.collector")
    ?? process.env.TRACER_COLLECTOR ?? COLLECTOR_ENTRY;
  const db = optionalString(record.db, "tracer.db") ?? process.env.TRACER_DB ?? join(DATA_ROOT, "trace.db");
  const spool = optionalString(record.spool, "tracer.spool") ?? process.env.TRACER_SPOOL ?? join(DATA_ROOT, "spool");
  const token = optionalString(record.token, "tracer.token") ?? process.env[optionalString(record.tokenEnv, "tracer.tokenEnv") ?? "TRACER_TOKEN"] ?? "";

  if (record.autostart !== undefined && typeof record.autostart !== "boolean") {
    throw new TypeError("tracer.autostart must be a boolean");
  }
  const timeoutMs = record.timeoutMs === undefined ? 30000 : record.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("tracer.timeoutMs must be a positive integer");
  }

  return {
    url: parsed.origin,
    collector,
    db,
    spool,
    token,
    autostart: record.autostart ?? true,
    timeoutMs,
  };
}

/** Node arguments that start the Collector, loading TypeScript sources when no build exists. */
export function collectorCommand(entry: string): string[] {
  return entry.endsWith(".ts") && existsSync(SOURCE_LOADER)
    ? ["--experimental-transform-types", "--import", SOURCE_LOADER, entry]
    : [entry];
}

/**
 * Resolves path options against the caller's base directory: the plugin factory passes
 * `runtime.resolvePath` so config-relative paths follow the project, while the CLI passes
 * `path.resolve` to keep shell-relative semantics. Validation itself never touches the filesystem.
 */
export function resolveTracerConfig(config: TracerConfig, resolvePath: (path: string) => string): TracerConfig {
  const one = (path: string) => (path === ":memory:" ? path : resolvePath(path));
  return {
    ...config,
    collector: one(config.collector),
    db: one(config.db),
    spool: one(config.spool),
  };
}
