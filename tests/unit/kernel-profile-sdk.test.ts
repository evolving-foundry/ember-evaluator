import { expect, test, vi } from "vitest";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { kernelProfile } from "../../src/adapters/kernel/profile.js";
import { KernelBenchmark, parseKernelConfig } from "../../src/plugins/benchmarks/protocols/kernel/index.js";
import type { EnvironmentSession, CommandSpec, ProcessHandle } from "../../src/core/contracts/environment.js";

async function fixture(mode: "complete" | "missing" | "cleanup" | "no-trace" | "missing-l2" | "wrong-seed" | "wrong-capture" = "complete", device = 0, operation: "evaluate" | "profile" = "profile", collection?: "Default" | "PipeTimeline,Default",
  processOptions: { outputBytes?: number; exitCode?: number; outputLimitBytes?: number; cleanupGraceMs?: number; cleanupTimeoutMs?: number } = {}) {
  const { outputBytes = 0, exitCode = 0, ...limits } = processOptions;
  const dir = await mkdtemp(join(tmpdir(), "kernel-profile-sdk-"));
  const manifest = join(dir, "manifest.json");
  await writeFile(join(dir, "problem.py"), "class Model: pass\n");
  await writeFile(join(dir, "candidate.py"), "def kernel_function(x): return x\n");
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, tasks: [{ id: "fixed", problem: "problem.py", candidate: "candidate.py", referenceKind: "pytorch" }] }));
  const workdir = join(dir, "work");
  const verifierOutputDir = join(workdir, "verifier");
  await mkdir(verifierOutputDir, { recursive: true });
  const commands: CommandSpec[] = [];
  let stopped = 0;
  const stopGrace: number[] = [];
  let replayRequest: unknown;
  const session: EnvironmentSession = {
    id: "session", workdir, verifierOutputDir, agentOutputDir: join(workdir, "agent"), metadata: null,
    async upload(source, target) { await mkdir(dirname(join(workdir, target)), { recursive: true }); await cp(source, join(workdir, target)); },
    async download(source, target) { await cp(join(workdir, source), target); },
    async exportState() { throw new Error("unused"); }, async restoreState() {}, async dispose() {},
    async start(command, signal): Promise<ProcessHandle> {
      signal.throwIfAborted(); commands.push(command);
      if (!command.args.includes("op")) throw new Error("profile unexpectedly ran precision or benchmark");
      const outArg = command.args.find(arg => arg.startsWith("--output="));
      const appArg = command.args.find(arg => arg.startsWith("--application="));
      if (!outArg || !appArg) throw new Error("missing msprof args");
      const requestPath = appArg.match(/--request ([^ ]+)/)?.[1];
      const resultPath = appArg.match(/--output ([^ ]+)/)?.[1];
      if (!requestPath || !resultPath) throw new Error("missing replay args");
      replayRequest = JSON.parse(await readFile(requestPath, "utf8"));
      if (mode !== "missing" && mode !== "cleanup") {
        const profile = join(outArg.slice("--output=".length), "OPPROF_fixture");
        await mkdir(profile, { recursive: true });
        await writeFile(join(profile, "PipeUtilization.csv"), "block_id,sub_block_id,aiv_vec_ratio,aiv_scalar_ratio,aiv_mte2_ratio,aiv_mte3_ratio,aiv_time(us)\n0,vector,0.7,0.2,0.4,0.1,10\n");
        if (mode !== "missing-l2") await writeFile(join(profile, "L2Cache.csv"), "block_id,sub_block_id\n0,vector\n");
        await writeFile(join(profile, "ResourceConflictRatio.csv"), "block_id,aiv_vec_wait_ratio\n0,0.1\n");
        if (mode === "complete") await writeFile(join(profile, "trace.json"), JSON.stringify({ traceEvents: [{ pid: "core0.veccore0", tid: "VECTOR", ts: 0, dur: 10 }] }));
        await writeFile(resultPath, JSON.stringify({ seed: mode === "wrong-seed" ? 41 : 42, warmup: 7, requestedLogicalDevice: 0, logicalDevice: 0, deviceCount: 1, capture: { method: "mstx", range: "rsi_operator_profile", toolId: 4097, rangeId: 0, warmupCompleted: mode === "wrong-capture" ? 6 : 7, callsInRange: 1 }, deviceName: "Ascend950PR", inputContract: "unchanged problem.get_inputs", environment: { device: "fixture950 logical=0", visibleDevices: "0" } }));
      }
      return { stdout: (async function* () { if (outputBytes) yield Buffer.from("x".repeat(outputBytes)); })(), stderr: (async function* () {})(), done: Promise.resolve({ code: exitCode, signal: null }),
        async stop(grace) { stopped++; stopGrace.push(grace); if (mode === "cleanup") throw new Error("cannot stop"); } };
    },
  };
  const benchmark = new KernelBenchmark(parseKernelConfig({ operation, device, manifest, seeds: [42], timeoutSeconds: 20, ...limits,
    profiling: { enabled: true, warmup: 7, cacheEnabled: false, maxAttempts: 1, attemptTimeoutSeconds: 10, retryDelayMs: 0, ...(collection === undefined ? {} : { collection }) } }));
  const signal = new AbortController().signal;
  const source = await benchmark.resolveSource(null, signal);
  const task = await benchmark.prepare({ id: "fixed", recordKey: "fixed" }, source, signal);
  for (const file of task.solveEnv.initialFiles) await session.upload(file.source, file.target, signal);
  const payload = task.input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.candidateSha256 !== "string") throw new Error("missing candidate hash");
  const solve = { finalText: payload.candidateSha256, usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
  return { dir, commands, benchmark, task, session, signal, solve, stopGrace, request: () => replayRequest, stopped: () => stopped };
}

test("profiling honors configured output capacity and cleanup grace", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { outputBytes: 1024, outputLimitBytes: 8, cleanupGraceMs: 43 });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", profiling: { error: expect.stringContaining("output exceeds limit") } } });
    expect(f.stopGrace).toEqual([43, 43]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("failed profiler preserves complete native console output", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { outputBytes: 5000, exitCode: 1 });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable" } });
    const consoleText = await readFile(join(f.session.verifierOutputDir, "kernel-profile_profiling_root/profiling/logs/console.log"), "utf8");
    expect(consoleText).toBe("x".repeat(5000));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("independent profile uses the SDK session and frozen seed without running precision or benchmark", async () => {
  const f = await fixture();
  try {
    expect(f.benchmark.evaluationKind).toBe("performance");
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict.passed).toBeNull(); expect(verdict).not.toHaveProperty("score");
    expect(verdict.details).toMatchObject({ operation: "profile", protocol: "kernel-profile/v1", status: "completed", cleanup: "confirmed",
      diagnosticProtocol: { caseId: "fixed", seeds: [42], warmup: 7, collection: "PipeTimeline,Default", capture: "after-warmup-mstx-range", selectionPolicy: "last" },
      profiling: { status: "completed", metadata: { attempts: 1, retryPolicy: { retryDelayMs: 0 }, trace: { status: "available", artifact: "trace.json" }, hardwareDerived: { ubRatio: "unavailable", coreUtilization: "unavailable" } } } });
    expect(verdict.details).not.toHaveProperty("candidateMs");
    expect(f.request()).toMatchObject({ seeds: [42], warmup: 7 });
    expect(f.request()).not.toHaveProperty("repeat"); expect(f.request()).not.toHaveProperty("rtol");
    expect(f.commands).toHaveLength(1); expect(f.stopped()).toBeGreaterThanOrEqual(1);
    expect(f.commands[0]?.args).toContain("--mstx=on");
    expect(f.commands[0]?.args).toContain("--mstx-include=rsi_operator_profile");
    const raw = await readFile(join(f.session.verifierOutputDir, "kernel-profile.raw.json"), "utf8");
    expect(raw).not.toContain('"core_utilization"'); expect(raw).not.toContain('"ub_ratio"');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("missing diagnostic artifacts are unavailable, not candidate failure, and retain raw evidence", async () => {
  const f = await fixture("missing");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", cleanup: "confirmed", profiling: { status: "failed" } } });
    expect(verdict).not.toHaveProperty("score");
    expect(await readFile(join(f.session.verifierOutputDir, "kernel-profile.raw.json"), "utf8")).toContain("msprof did not create");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("unconfirmed profile cleanup remains an infrastructure error", async () => {
  const f = await fixture("cleanup");
  try { await expect(f.benchmark.verify(f.task, f.solve, f.session, f.signal)).rejects.toThrow(/cleanup unconfirmed/i); }
  finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("independent profile rejects multiple seeds and inherited disk cache", () => {
  expect(() => parseKernelConfig({ operation: "profile", manifest: "m", seeds: [1, 2], profiling: { enabled: true, cacheEnabled: false } })).toThrow(/single seed/i);
  expect(() => parseKernelConfig({ operation: "profile", manifest: "m", seeds: [42], profiling: { enabled: true, cacheEnabled: true } })).toThrow(/cache/i);
});


test("cancelling an SDK diagnostic propagates without starting precision or another replay", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); controller.abort(new Error("cancelled diagnostic"));
    await expect(f.benchmark.verify(f.task, f.solve, f.session, controller.signal)).rejects.toThrow(/cancelled diagnostic/);
    expect(f.commands).toHaveLength(0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});


test.each([
  { device: 0, visible: "0" },
  { device: 3, visible: "3" },
])("profile binds only configured device $device despite inherited multi-card visibility", async ({ device, visible }) => {
  vi.stubEnv("ASCEND_VISIBLE_DEVICES", "0,1");
  vi.stubEnv("ASCEND_RT_VISIBLE_DEVICES", "0,1");
  const f = await fixture("complete", device);
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict.details).toMatchObject({ status: "completed" });
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.env).toMatchObject({
      ASCEND_VISIBLE_DEVICES: visible,
      ASCEND_RT_VISIBLE_DEVICES: visible,
      KERNEL_NPU_DEVICE: "0",
    });
    expect(f.task.solveEnv.env).toMatchObject({
      ASCEND_VISIBLE_DEVICES: visible,
      ASCEND_RT_VISIBLE_DEVICES: visible,
      KERNEL_NPU_DEVICE: "0",
    });
    expect(f.commands[0]?.env?.PRESERVE_ENV?.split(",")).toEqual(expect.arrayContaining([
      "ASCEND_VISIBLE_DEVICES", "ASCEND_RT_VISIBLE_DEVICES", "KERNEL_NPU_DEVICE",
    ]));
  } finally {
    vi.unstubAllEnvs();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("evaluate prepares a single configured card with logical device zero", async () => {
  vi.stubEnv("ASCEND_VISIBLE_DEVICES", "0,1");
  vi.stubEnv("ASCEND_RT_VISIBLE_DEVICES", "0,1");
  const f = await fixture("complete", 0, "evaluate");
  try {
    expect(f.task.solveEnv.env).toMatchObject({
      ASCEND_VISIBLE_DEVICES: "0",
      ASCEND_RT_VISIBLE_DEVICES: "0",
      KERNEL_NPU_DEVICE: "0",
    });
    expect(f.commands).toHaveLength(0);
  } finally {
    vi.unstubAllEnvs();
    await rm(f.dir, { recursive: true, force: true });
  }
});


test.each(["no-trace", "complete"] as const)("explicit Default diagnostics use PMU evidence and ignore pipeline trace (%s)", async (mode) => {
  const f = await fixture(mode, 0, "profile", "Default");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: {
      status: "completed", cleanup: "confirmed", diagnosticProtocol: { collection: "Default", capture: "after-warmup-mstx-range" },
      profiling: { metadata: { collection: "Default",
        trace: { status: "unavailable", reason: "not-requested-by-default-protocol" },
        replay: { seed: 42, warmup: 7, environment: { device: "fixture950 logical=0", visibleDevices: "0" } } },
        analysis: { trace: null, roofline: { vec_rate: 0.7 } } },
    } });
    expect(verdict).not.toHaveProperty("score");
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.args).toContain("--aic-metrics=Default");
    expect(f.stopped()).toBeGreaterThanOrEqual(1);
    const output: unknown = JSON.parse(await readFile(join(f.session.verifierOutputDir, "kernel-profile.json"), "utf8"));
    expect(output).toMatchObject({ trace_analysis: null, roofline: { vec_rate: 0.7 } });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("full diagnostics still require trace and never retry as Default", async () => {
  const f = await fixture("no-trace");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: {
      status: "unavailable", diagnosticProtocol: { collection: "PipeTimeline,Default" },
      profiling: { status: "failed", error: expect.stringContaining("No trace.json") },
    } });
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.args).toContain("--aic-metrics=PipeTimeline,Default");
    expect(f.commands[0]?.args).not.toContain("--aic-metrics=Default");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("Default diagnostics still require the complete PMU CSV set", async () => {
  const f = await fixture("missing-l2", 0, "profile", "Default");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", diagnosticProtocol: { collection: "Default" },
      profiling: { error: expect.stringContaining("No L2Cache.csv") } } });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("profiling collection is explicit, defaults to full, and rejects unsupported values", () => {
  expect(parseKernelConfig({ manifest: "m" }).profiling).toMatchObject({ collection: "PipeTimeline,Default" });
  expect(parseKernelConfig({ manifest: "m", profiling: { collection: "Default" } }).profiling).toMatchObject({ collection: "Default" });
  for (const collection of [null, "default", "PipeTimeline", "Default,PipeTimeline", ["Default"], 0])
    expect(() => parseKernelConfig({ manifest: "m", profiling: { collection } })).toThrow(/profiling.collection/);
});


test("Default diagnostics retain the actual replay seed check", async () => {
  const f = await fixture("wrong-seed", 0, "profile", "Default");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", diagnosticProtocol: { collection: "Default" },
      profiling: { error: expect.stringContaining("Replay effective input protocol mismatch") } } });
    expect(f.commands).toHaveLength(1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});


test.each(["Default", "PipeTimeline,Default"] as const)("diagnostics require actual capture receipts (%s)", async (collection) => {
  const f = await fixture("wrong-capture", 0, "profile", collection);
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", diagnosticProtocol: { collection },
      profiling: { error: expect.stringContaining("Replay effective capture protocol mismatch") } } });
    expect(f.commands).toHaveLength(1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});


test("capture cache preserves receipts and separates collection and seed protocols", async () => {
  const f = await fixture();
  try {
    const args = { problem: join(f.dir, "problem.py"), kernel: join(f.dir, "candidate.py"),
      round: 1, seed: 42, warmup: 7, caseId: "fixed", cacheEnabled: true, cacheDir: join(f.dir, "cache") };
    const options = { env: { ASCEND_RT_VISIBLE_DEVICES: "0", KERNEL_NPU_DEVICE: "0" } };
    const execution = { session: f.session, atomDirectory: join(f.session.workdir, "runtime") };
    const first = await kernelProfile({ ...args, collection: "Default", out: join(f.dir, "first.json") }, options, execution);
    expect(first.error).toBe("");
    const cached = await kernelProfile({ ...args, collection: "Default", out: join(f.dir, "cached.json") }, options, execution);
    expect(cached.error).toBe("");
    const cachedRaw: unknown = JSON.parse(await readFile(join(f.dir, "cached.raw.json"), "utf8"));
    expect(cachedRaw).toMatchObject({ status: "completed", metadata: { cacheHit: true,
      replay: { seed: 42, capture: { method: "mstx", warmupCompleted: 7, callsInRange: 1 } } } });
    expect(f.commands).toHaveLength(1);
    const full = await kernelProfile({ ...args, collection: "PipeTimeline,Default", out: join(f.dir, "full.json") }, options, execution);
    expect(full.error).toBe("");
    expect(f.commands).toHaveLength(2);
    expect(f.commands[0]?.args).toContain("--aic-metrics=Default");
    expect(f.commands[1]?.args).toContain("--aic-metrics=PipeTimeline,Default");
    const differentSeed = await kernelProfile({ ...args, seed: 43, collection: "Default", out: join(f.dir, "seed43.json") }, options, execution);
    expect(differentSeed.error).toContain("Replay effective input protocol mismatch");
    expect(f.commands).toHaveLength(3);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
