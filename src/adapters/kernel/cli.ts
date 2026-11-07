import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
export const MAX_KERNEL_TIMER_MS = 2147483647;

/**
 * Execution bridge for the Evaluator CLI kernel subcommands.
 *
 * Python workers in src/adapters/kernel/ cover three NPU operations:
 * - precision.py: compare two runs per seed against problem.Model using kernel tolerances;
 * - timing.py: benchmark device kernels with --triton-only, 25 warmups and 100 repeats;
 * - msprof_replay.py: replay the operator under the msprof process.
 * Profiling orchestration, parsing, caching and roofline classification live in ./profile.ts.
 * Each worker returns one JSON payload on the final stdout line. Evaluation failures
 * return a nonempty payload.error; missing interpreters, timeouts, cancellation and missing JSON throw KernelExecError.
 * RSI owns measure/verify orchestration, including artifact sets, verify.json and workdir scans.
 * These workers expose only the three measurement operations required by that orchestration.
 */

/** Execution environment failures, including missing worker directories or interpreters. */
export class KernelExecError extends Error {
  override readonly name = "KernelExecError";

  constructor(readonly sub: string, readonly exitCode: number | null, message: string,
    readonly infra: boolean, readonly payload?: unknown) {
    super(message);
  }
}

export interface KernelExecOptions {
  python?: string;
  env?: Readonly<Record<string, string>>;
  /** Logical NPU index passed as KERNEL_NPU_DEVICE; the worker uses its environment when omitted. */
  device?: number;
  timeoutMs?: number;
  /** Per stdout/stderr stream; omitted preserves complete output. */
  outputLimitBytes?: number;
  cleanupGraceMs?: number;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
}

export function validateKernelExecOptions(options: KernelExecOptions): void {
  for (const name of ["outputLimitBytes", "cleanupGraceMs", "cleanupTimeoutMs"] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError(`${name} must be a positive integer`);
  }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0))
    throw new TypeError("timeoutMs must be a non-negative integer");
  for (const name of ["timeoutMs", "cleanupGraceMs", "cleanupTimeoutMs"] as const)
    if (options[name] !== undefined && options[name] > MAX_KERNEL_TIMER_MS)
      throw new TypeError(`${name} exceeds the Node timer range (${MAX_KERNEL_TIMER_MS} ms)`);
}

/**
 * Locate the worker directory: use KERNEL_ATOM_DIR when explicitly configured;
 * otherwise search ancestors of the injectable moduleDir for src/adapters/kernel/precision.py.
 */
export function resolveAtomDir(sub: string, options: KernelExecOptions = {},
  moduleDir: string = dirname(fileURLToPath(import.meta.url))): string {
  const explicit = process.env.KERNEL_ATOM_DIR;
  if (explicit !== undefined && explicit !== "" && existsSync(join(explicit, "precision.py")))
    return explicit;
  // Published packages carry Python workers beside this compiled module.
  if (existsSync(join(moduleDir, "precision.py"))) return moduleDir;
  let dir = moduleDir;
  for (;;) {
    const candidate = join(dir, "src", "adapters", "kernel", "precision.py");
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new KernelExecError(sub, null,
    `kernel ${sub} cannot locate the kernel python entries: set KERNEL_ATOM_DIR to the adapters/kernel directory`, true);
}

/** Relevant child-process failure fields, narrowed from ExecFileException. */
interface ExecFailure {
  code?: unknown;
  killed?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

/** Classify missing interpreters, timeouts and cancellation as infrastructure failures. */
export function kernelFailure(sub: string, error: unknown): KernelExecError {
  const cause = error instanceof Object ? error as ExecFailure : {};
  if (cause.code === "ENOENT")
    return new KernelExecError(sub, null, `python interpreter not found for kernel ${sub}`, true);
  if (cause.killed === true)
    return new KernelExecError(sub, null, `kernel ${sub} was killed (timeout or cancellation)`, true);
  if (error instanceof Error && error.name === "AbortError")
    return new KernelExecError(sub, null, `kernel ${sub} was cancelled`, true);
  const code = cause.code;
  return new KernelExecError(sub, typeof code === "number" ? code : null,
    `kernel ${sub} failed: ${error instanceof Error ? error.message : String(error)}`, true);
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Parse JSON from the final nonempty stdout line, tolerating preceding CANN output. */
export function parseAtomPayload(sub: string, stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter((line) => line.trim() !== "");
  const last = lines[lines.length - 1] ?? "";
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch (error) {
    throw new KernelExecError(sub, null, `kernel ${sub} printed no JSON: ${String(error)}`, true,
      stdout);
  }
}

/** Return worker payloads, including recorded evaluation failures with nonzero exit codes. */
async function runEntry(sub: string, entry: string, argv: readonly string[], out: string,
  options: KernelExecOptions = {}): Promise<Record<string, unknown>> {
  validateKernelExecOptions(options);
  const atomDir = resolveAtomDir(sub, options);
  const env = {
    ...process.env,
    ...options.env,
    ...(options.device === undefined ? {} : { KERNEL_NPU_DEVICE: String(options.device) }),
    PYTHONPATH: process.env.PYTHONPATH === undefined || process.env.PYTHONPATH === ""
      ? atomDir
      : `${atomDir}${delimiter}${process.env.PYTHONPATH}`,
  };
  let payload: Record<string, unknown> | undefined;
  try {
    const { stdout } = await execFileAsync(options.python ?? "python",
      [join(atomDir, entry), ...argv], {
        cwd: atomDir, env, maxBuffer: options.outputLimitBytes ?? Infinity, windowsHide: true,
        timeout: options.timeoutMs ?? 900_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    payload = parseAtomPayload(sub, stdout);
  } catch (error) {
    const cause = error instanceof Object ? error as ExecFailure : {};
    if (cause.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || cause.killed === true || (error instanceof Error && error.name === "AbortError"))
      throw kernelFailure(sub, error);
    // Evaluation failures may already have written --out with an error field; read that payload.
    payload = await readJson(out);
    if (payload === undefined) throw kernelFailure(sub, error);
  }
  return payload ?? (await readJson(out)) ?? {};
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// ---------------- Three measurement operations: two Python workers and one TS orchestrator ----------------

export interface KernelBenchArgs { problem: string; kernel: string; out: string; warmup?: number; repeat?: number }

export interface KernelBenchResult extends Record<string, unknown> {
  problem: string; kernel: string; out: string;
  time_ms: number | null; error: string;
}

/** Benchmark Triton kernels only; the precision worker owns correctness checks. */
export async function kernelBench(args: KernelBenchArgs, options: KernelExecOptions = {}): Promise<KernelBenchResult> {
  for (const name of ["warmup", "repeat"] as const)
    if (args[name] !== undefined && (!Number.isSafeInteger(args[name]) || args[name] <= 0)) throw new TypeError(`${name} must be a positive integer`);
  const payload = await runEntry("bench", "timing.py",
    ["--problem", args.problem, "--kernel", args.kernel, "--out", args.out,
      ...(args.warmup === undefined ? [] : ["--warmup", String(args.warmup)]),
      ...(args.repeat === undefined ? [] : ["--repeat", String(args.repeat)])],
    args.out, options);
  return { problem: args.problem, kernel: args.kernel, out: args.out,
    time_ms: num(payload["time_ms"]), error: str(payload["error"]) };
}

export interface KernelPrecisionResult extends Record<string, unknown> {
  problem: string; kernel: string; passed: boolean; error: string;
  tolerance: Record<string, unknown>;
}

/** Run twice per seed against problem.Model with the kernel correctness tolerances. */
export async function kernelPrecision(args: KernelBenchArgs & { seeds?: number[] },
  options: KernelExecOptions = {}): Promise<KernelPrecisionResult> {
  const seeds = args.seeds ?? [0, 1];
  const payload = await runEntry("precision", "precision.py",
    ["precision", "--problem", args.problem, "--kernel", args.kernel, "--out", args.out,
      "--seeds", ...seeds.map(String)],
    args.out, options);
  return { problem: args.problem, kernel: args.kernel,
    passed: payload["passed"] === true, error: str(payload["error"]),
    tolerance: payload["tolerance"] !== null && typeof payload["tolerance"] === "object"
      ? payload["tolerance"] as Record<string, unknown> : {} };
}

export { kernelProfile } from "./profile.js";

