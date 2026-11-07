import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { collectorCommand, parseTracerConfig, resolveTracerConfig } from "./config.js";

export type TracerAction = "serve" | "stop" | "status" | "logs";

export type TracerCommand = {
  action: TracerAction;
  url?: string;
  db?: string;
  spool?: string;
  port?: number;
  timeoutMs?: number;
  log?: string;
  lines?: number;
  follow?: boolean;
};

export type TracerIO = { out(text: string): void; error(text: string): void };

/** Usage errors keep the host's argument-phase diagnostics; runtime errors are reported as Collector failures. */
export type TracerCliResult = { ok: true; status: number } | { ok: false; error: unknown; usage: boolean };

const USAGE = [
  "Usage: ember-evaluator tracer <serve|stop|status|logs> [options]",
  "",
  "Commands:",
  "  serve    Start the Collector, or reuse an already healthy instance",
  "  stop     Stop the process recorded in tracer.pid",
  "  status   Print Collector status as JSON; exits non-zero when unhealthy",
  "  logs     Print the tail of collector.log, optionally following new lines",
].join("\n");

type ResolvedTracer = {
  url: string;
  db: string;
  spool: string;
  collector: string;
  token: string;
  log: string;
  pidFile: string;
  timeoutMs: number;
};

type PidRecord = {
  pid: number;
  url: string;
  db: string;
  spool: string;
  collector: string;
  log: string;
  startedAt: string;
};

type Health = { ok?: boolean; db?: string | null; spool?: string };

const MAX_LOG_BYTES = 20 * 1024 * 1024;
const ROTATED_LOGS = 3;
const DEFAULT_LOG_LINES = 200;
const GRACEFUL_STOP_MS = 5000;
const FORCED_STOP_MS = 2000;
const POLL_INTERVAL_MS = 300;

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

function parseTracerArgs(argv: string[]): TracerCommand {
  const action = argv[0];
  if (action !== "serve" && action !== "stop" && action !== "status" && action !== "logs")
    throw new TypeError("Expected tracer serve|stop|status|logs");
  const command: TracerCommand = { action };
  const text = (option: string, key: "url" | "db" | "spool" | "log", value: string | undefined) => {
    if (command[key] !== undefined || value === undefined || value.startsWith("-"))
      throw new TypeError(`Repeated or incomplete ${option} option`);
    command[key] = value;
  };
  const count = (option: string, key: "port" | "timeoutMs" | "lines", value: string | undefined) => {
    if (command[key] !== undefined || value === undefined || !/^\d+$/u.test(value) || Number(value) <= 0)
      throw new TypeError(`Repeated or invalid ${option} option`);
    command[key] = Number(value);
  };
  for (let index = 1; index < argv.length; ) {
    const option = argv[index]!;
    const value = argv[index + 1];
    if ((option === "--follow" || option === "-f") && action === "logs") {
      if (command.follow === true) throw new TypeError("Repeated --follow option");
      command.follow = true;
      index += 1;
      continue;
    }
    if (option === "--url" || option === "--db" || option === "--spool") {
      text(option, option.slice(2) as "url" | "db" | "spool", value);
      index += 2;
      continue;
    }
    if ((option === "--log" || option === "--lines") && action !== "logs")
      throw new TypeError(`${option} is only valid for tracer logs`);
    if (option === "--log") { text(option, "log", value); index += 2; continue; }
    if (option === "--lines") { count(option, "lines", value); index += 2; continue; }
    if (option === "--timeout" && action !== "serve")
      throw new TypeError("--timeout is only valid for tracer serve");
    if (option === "--port" && action === "logs")
      throw new TypeError("--port is not valid for tracer logs");
    if (option === "--port") { count(option, "port", value); index += 2; continue; }
    if (option === "--timeout") { count(option, "timeoutMs", value); index += 2; continue; }
    throw new TypeError(`Unknown tracer ${action} option: ${option}`);
  }
  return command;
}

/** Parses the subcommand arguments, runs it and maps failures back to the host CLI. */
export async function runPluginCli(argv: string[], io: TracerIO, signal: AbortSignal): Promise<TracerCliResult> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.out(USAGE);
    return { ok: true, status: 0 };
  }
  let command: TracerCommand;
  try {
    command = parseTracerArgs(argv);
  } catch (error) {
    return { ok: false, error, usage: true };
  }
  try {
    return { ok: true, status: await runTracerCommand(command, io, signal) };
  } catch (error) {
    return { ok: false, error, usage: false };
  }
}

/** Runs a tracer subcommand and returns the process exit code. */
async function runTracerCommand(command: TracerCommand, io: TracerIO, signal: AbortSignal): Promise<number> {
  const configured = resolveTracer(command);
  const record = command.action === "serve" ? null : readPid(configured.pidFile);
  // The pid record knows the port, log and spool the Collector was actually started with
  const tracer = record === null ? configured : {
    ...configured,
    url: command.url === undefined && command.port === undefined && record.url ? record.url : configured.url,
    log: command.log === undefined && record.log ? record.log : configured.log,
    spool: command.spool === undefined && record.spool ? record.spool : configured.spool,
  };
  if (command.action === "serve") return serve(tracer, io);
  if (command.action === "stop") return stop(tracer, io, record);
  if (command.action === "status") return status(tracer, io, record);
  return logs(tracer, io, signal, command.lines ?? DEFAULT_LOG_LINES, command.follow === true);
}

/**
 * Resolves the Collector configuration with the plugin's own parser and environment variables,
 * so `run --tracer` and `tracer serve` always manage the same process.
 */
function resolveTracer(command: TracerCommand): ResolvedTracer {
  let url = command.url ?? process.env.TRACER_URL ?? "http://127.0.0.1:8787";
  if (command.port !== undefined) {
    const parsed = new URL(url);
    parsed.port = String(command.port);
    url = parsed.origin;
  }
  const config = resolveTracerConfig(
    parseTracerConfig({ url, db: command.db, spool: command.spool, timeoutMs: command.timeoutMs }),
    path => resolve(path),
  );
  return {
    url: config.url,
    db: config.db,
    spool: config.spool,
    collector: config.collector,
    token: config.token,
    log: resolve(command.log ?? process.env.TRACER_LOG ?? join(dirname(config.db), "collector.log")),
    pidFile: join(dirname(config.db), "tracer.pid"),
    timeoutMs: config.timeoutMs,
  };
}

async function probe(tracer: ResolvedTracer, timeoutMs = 1500): Promise<Health | null> {
  try {
    const response = await fetch(`${tracer.url}/healthz`, {
      headers: tracer.token ? { authorization: `Bearer ${tracer.token}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Health;
    return body && body.ok ? body : null;
  } catch {
    return null;
  }
}

function databaseMismatch(health: Health, tracer: ResolvedTracer): string | null {
  if (!health.db) return null;
  if (resolve(health.db) === resolve(tracer.db)) return null;
  return `Collector at ${tracer.url} uses database ${health.db}, but ${tracer.db} is configured`;
}

/** Collector arguments shared with the plugin's autostart path. */
function collectorArgs(tracer: ResolvedTracer): string[] {
  const url = new URL(tracer.url);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return [...collectorCommand(tracer.collector), "--host", url.hostname, "--port", port, "--db", tracer.db, "--spool", tracer.spool];
}

/** Passes the bearer token through the environment so it never shows up in process listings or error text. */
function collectorEnv(tracer: ResolvedTracer): NodeJS.ProcessEnv {
  return tracer.token ? { ...process.env, TRACER_TOKEN: tracer.token } : process.env;
}

/** Rotates the Collector log once it exceeds the size budget, keeping a bounded number of generations. */
function rotateLog(path: string): void {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return;
    for (let generation = ROTATED_LOGS - 1; generation >= 1; generation--) {
      try { renameSync(`${path}.${generation}`, `${path}.${generation + 1}`); } catch { /* Missing generation. */ }
    }
    renameSync(path, `${path}.1`);
  } catch { /* No log yet. */ }
}

function openLog(path: string): number | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return openSync(path, "a");
  } catch {
    return undefined;
  }
}

async function readTail(path: string, lines = 8): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.trimEnd().split(/\r?\n/u).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function readPid(file: string): PidRecord | null {
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as PidRecord;
    if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) return null;
    return record;
  } catch {
    return null;
  }
}

function writePid(file: string, record: PidRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function removePid(file: string): void {
  rmSync(file, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guards against stopping a recycled pid: the recorded pid must still run the Collector entrypoint.
 * Platforms without /proc fall back to the liveness check alone.
 */
function runsCollector(pid: number, collector: string): boolean {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.some(argument => argument === collector || argument.endsWith("collector/main.js") || argument.endsWith("collector/main.ts"));
  } catch {
    return true;
  }
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(100);
  }
  return !alive(pid);
}

async function serve(tracer: ResolvedTracer, io: TracerIO): Promise<number> {
  const health = await probe(tracer);
  if (health) {
    const mismatch = databaseMismatch(health, tracer);
    if (mismatch) throw new Error(mismatch);
    const record = readPid(tracer.pidFile);
    io.out(JSON.stringify({
      action: "serve",
      started: false,
      reused: true,
      url: tracer.url,
      pid: record !== null && alive(record.pid) ? record.pid : null,
      db: tracer.db,
      spool: tracer.spool,
      log: tracer.log,
      pidFile: tracer.pidFile,
    }, null, 2));
    return 0;
  }

  // Never spawn a second Collector on the same database just because the requested port changed
  const existing = readPid(tracer.pidFile);
  if (existing !== null && alive(existing.pid) && runsCollector(existing.pid, existing.collector || tracer.collector)) {
    throw new Error(`Collector for ${tracer.db} is already running at ${existing.url} (pid ${existing.pid}); `
      + `stop it with tracer stop or use --url ${existing.url}`);
  }
  removePid(tracer.pidFile);
  rotateLog(tracer.log);
  const logDescriptor = openLog(tracer.log);
  const child = spawn(process.execPath, collectorArgs(tracer), {
    detached: true,
    windowsHide: true,
    env: collectorEnv(tracer),
    stdio: ["ignore", logDescriptor ?? "ignore", logDescriptor ?? "ignore"],
  });
  if (logDescriptor !== undefined) closeSync(logDescriptor);
  let exited: string | null = null;
  child.once("error", error => { exited = error.message; });
  child.once("exit", (code, signal) => { exited = `exited with ${signal ?? `code ${code ?? "unknown"}`}`; });
  child.unref();

  if (child.pid !== undefined) {
    writePid(tracer.pidFile, {
      pid: child.pid,
      url: tracer.url,
      db: tracer.db,
      spool: tracer.spool,
      collector: tracer.collector,
      log: tracer.log,
      startedAt: new Date().toISOString(),
    });
  }

  const deadline = Date.now() + tracer.timeoutMs;
  while (Date.now() < deadline) {
    const started = await probe(tracer, 1000);
    if (started) {
      const mismatch = databaseMismatch(started, tracer);
      if (mismatch) {
        removePid(tracer.pidFile);
        throw new Error(mismatch);
      }
      io.out(JSON.stringify({
        action: "serve",
        started: true,
        reused: false,
        url: tracer.url,
        pid: child.pid ?? null,
        db: tracer.db,
        spool: tracer.spool,
        log: tracer.log,
        pidFile: tracer.pidFile,
      }, null, 2));
      return 0;
    }
    if (exited) break;
    await delay(POLL_INTERVAL_MS);
  }

  removePid(tracer.pidFile);
  if (child.pid !== undefined && alive(child.pid)) process.kill(child.pid, "SIGKILL");
  const tail = await readTail(tracer.log);
  const reason = exited ?? `not healthy within ${tracer.timeoutMs}ms`;
  throw new Error(`Collector ${reason} at ${tracer.url}; log: ${tracer.log}${tail ? `\n${tail}` : ""}`);
}

async function stop(tracer: ResolvedTracer, io: TracerIO, record: PidRecord | null): Promise<number> {
  if (record === null) {
    const health = await probe(tracer);
    // Only refuse when the healthy Collector works on the configured database; another instance must not block
    if (health && (!health.db || resolve(health.db) === resolve(tracer.db))) {
      throw new Error(`Collector at ${tracer.url} is running but ${tracer.pidFile} is missing; `
        + "refusing to stop by process pattern, stop it manually or restart it with tracer serve");
    }
    io.out(JSON.stringify({ action: "stop", stopped: false, pid: null, url: tracer.url }, null, 2));
    return 0;
  }
  if (!alive(record.pid) || !runsCollector(record.pid, record.collector || tracer.collector)) {
    removePid(tracer.pidFile);
    io.out(JSON.stringify({ action: "stop", stopped: false, pid: record.pid, stale: true, url: tracer.url }, null, 2));
    return 0;
  }

  let signal: "SIGTERM" | "SIGKILL" = "SIGTERM";
  process.kill(record.pid, signal);
  if (!(await waitExit(record.pid, GRACEFUL_STOP_MS))) {
    signal = "SIGKILL";
    try { process.kill(record.pid, signal); } catch { /* Already gone. */ }
    await waitExit(record.pid, FORCED_STOP_MS);
  }
  removePid(tracer.pidFile);
  io.out(JSON.stringify({ action: "stop", stopped: true, pid: record.pid, signal, url: tracer.url }, null, 2));
  return 0;
}

async function status(tracer: ResolvedTracer, io: TracerIO, record: PidRecord | null): Promise<number> {
  const health = await probe(tracer);
  const pid = record !== null && alive(record.pid) ? record.pid : null;
  const startedAt = pid !== null && record?.startedAt ? Date.parse(record.startedAt) : Number.NaN;
  const databaseMatches = health?.db ? resolve(health.db) === resolve(tracer.db) : null;
  // A Collector that answers on the URL but serves another database is not this installation
  const running = health !== null && databaseMatches !== false;
  io.out(JSON.stringify({
    action: "status",
    running,
    healthy: running,
    url: tracer.url,
    pid,
    db: tracer.db,
    spool: tracer.spool,
    log: tracer.log,
    pidFile: tracer.pidFile,
    databaseMatches,
    uptimeSeconds: Number.isFinite(startedAt) ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null,
  }, null, 2));
  return running ? 0 : 1;
}

async function logs(tracer: ResolvedTracer, io: TracerIO, signal: AbortSignal, lines: number, follow: boolean): Promise<number> {
  let content: string;
  try {
    content = await readFile(tracer.log, "utf8");
  } catch {
    throw new Error(`no Collector log at ${tracer.log}`);
  }
  const tail = content.trimEnd().split(/\r?\n/u).slice(-lines);
  if (tail.length) io.out(tail.join("\n"));
  if (!follow) return 0;

  let offset = Buffer.byteLength(content);
  while (!signal.aborted) {
    await delay(POLL_INTERVAL_MS);
    let size: number;
    try { size = (await stat(tracer.log)).size; } catch { continue; }
    if (size < offset) offset = 0;
    if (size <= offset) continue;
    const handle = await open(tracer.log, "r");
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      offset = size;
      const chunk = buffer.toString("utf8").replace(/\n+$/u, "");
      if (chunk) io.out(chunk);
    } finally {
      await handle.close();
    }
  }
  return 0;
}
