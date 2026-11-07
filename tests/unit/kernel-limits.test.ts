import { expect, test, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NpuKernelBackend } from "../../src/adapters/kernel/npu.js";
import { readProcess } from "../../src/adapters/verifiers/process.js";
import { startLocalProcess } from "../../src/plugins/environments/process.js";
import { parseKernelConfig } from "../../src/plugins/benchmarks/protocols/kernel/index.js";
import { MsProfCache } from "../../src/plugins/benchmarks/protocols/kernel/msprof-cache.js";
import { parseArgs } from "../../src/cli.js";
import { kernelBench, validateKernelExecOptions } from "../../src/adapters/kernel/cli.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";

test("kernel configuration accepts large seed sets and explicit resource limits", () => {
  const config = parseKernelConfig({ manifest: "m", seeds: Array.from({ length: 101 }, (_, i) => i),
    outputLimitBytes: 2_000_000, cleanupGraceMs: 50, cleanupTimeoutMs: 5000,
    profiling: { cacheMaxEntries: 3, retryDelayMs: 0 } });
  expect(config.seeds).toHaveLength(101);
  expect(config.outputLimitBytes).toBe(2_000_000);
  expect(config.profiling.cacheMaxEntries).toBe(3);
  expect(config.profiling.retryDelayMs).toBe(0);
  for (const seeds of [[1, 1], [-1], [0x100000000]])
    expect(() => parseKernelConfig({ manifest: "m", seeds })).toThrow();
  expect(() => parseKernelConfig({ manifest: "m", outputLimitBytes: 0 })).toThrow(/outputLimitBytes/);
  expect(() => parseKernelConfig({ manifest: "m", profiling: { retryDelayMs: -1 } })).toThrow(/retryDelayMs/);
});

test("kernel process timers reject values outside Node's timer range", () => {
  for (const key of ["timeoutMs", "cleanupGraceMs", "cleanupTimeoutMs"] as const)
    expect(() => validateKernelExecOptions({ [key]: 2147483648 })).toThrow(/timer range/);
  expect(() => validateKernelExecOptions({ timeoutMs: 2147483647 })).not.toThrow();
  expect(() => parseKernelConfig({ manifest: "m", timeoutSeconds: 2147484 })).toThrow(/timeoutSeconds.*timer range/);
  expect(() => parseKernelConfig({ manifest: "m", profiling: { attemptTimeoutSeconds: 2147484 } })).toThrow(/attemptTimeoutSeconds.*timer range/);
});

test("NPU worker accepts complete results beyond one MiB and honors an explicit output limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-output-"));
  const response = { status: "incorrect", error: "x".repeat(1024 * 1024 + 128) };
  const bytes = Buffer.from(JSON.stringify(response));
  const session: EnvironmentSession = { id: "fixture", workdir: root, agentOutputDir: root, verifierOutputDir: root, metadata: null,
    async start() { return { stdout: (async function* () { yield bytes; })(), stderr: (async function* () {})(),
      done: Promise.resolve({ code: 0, signal: null }), async stop() {} }; },
    async upload() {}, async download() {}, async exportState() { throw new Error("unused"); }, async restoreState() {}, async dispose() {} };
  const config = { python: "fixture", device: 0, profiling: { enabled: false, roundNum: 1 } };
  try {
    await writeFile(join(root, "kernel-result.json"), bytes);
    const signal = new AbortController().signal;
    expect(await new NpuKernelBackend(config).execute({}, session, signal)).toEqual(response);
    await expect(new NpuKernelBackend({ ...config, outputLimitBytes: 1024 }).execute({}, session, signal)).rejects.toThrow(/output exceeds limit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("complete local process capture preserves output produced before iteration starts", async () => {
  const handle = await startLocalProcess({ executable: process.execPath,
    args: ["-e", "process.stdout.write('a'.repeat(2 * 1024 * 1024));"], cwd: tmpdir(), env: {}, input: null,
    outputBufferBytes: null }, new AbortController().signal);
  await handle.done;
  const result = await readProcess(handle, new AbortController().signal, null);
  expect(result.stdout.length).toBe(2 * 1024 * 1024);
  expect(result.stdout.startsWith("aaa")).toBe(true);
});

test("profiling cache prunes only when callers configure a capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-cache-limit-"));
  try {
    const directory = join(root, "cache");
    const cache = await MsProfCache.open("fixture", directory);
    if (!cache) throw new Error("cache unavailable");
    for (let i = 0; i < 513; i++) await cache.put(Buffer.from(String(i)), "fixture", "", {}, {}, null);
    const keys = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name));
    expect(keys).toHaveLength(513);
    const limited = await MsProfCache.open("fixture", directory, undefined, 2);
    if (!limited) throw new Error("cache unavailable");
    await limited.put(Buffer.from("last"), "fixture", "", {}, {}, null);
    expect((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("standalone bench forwards iteration controls and enforces explicit output capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-bench-options-"));
  vi.stubEnv("KERNEL_ATOM_DIR", root);
  try {
    const out = join(root, "out.json");
    await writeFile(join(root, "precision.py"), "// worker location\n");
    await writeFile(join(root, "timing.py"), `const fs = require('node:fs'); const args = process.argv.slice(2); const out = args[args.indexOf('--out') + 1]; fs.writeFileSync(out, JSON.stringify({time_ms: 1, error: '', args})); console.log(JSON.stringify({time_ms: 1, error: ''}));\n`);
    const args = { problem: "p.py", kernel: "k.py", out, warmup: 11, repeat: 123 };
    expect((await kernelBench(args, { python: process.execPath, timeoutMs: 7000 })).time_ms).toBe(1);
    expect(JSON.parse(await readFile(out, "utf8")).args).toEqual(["--problem", "p.py", "--kernel", "k.py", "--out", out, "--warmup", "11", "--repeat", "123"]);
    await expect(kernelBench(args, { python: process.execPath, outputLimitBytes: 10 })).rejects.toThrow(/maxBuffer|output/i);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

test("kernel CLI exposes workload and process controls", () => {
  const base = ["--problem", "p.py", "--kernel", "k.py", "--out", "r.json"];
  expect(parseArgs(["kernel", "bench", ...base, "--warmup", "11", "--repeat", "123", "--timeout-ms", "7000", "--output-limit-bytes", "2000000"]))
    .toMatchObject({ kind: "kernel-bench", warmup: 11, repeat: 123, timeoutMs: 7000, outputLimitBytes: 2000000 });
  expect(parseArgs(["kernel", "profile", ...base, "--max-attempts", "7", "--attempt-timeout-seconds", "600", "--cache-max-entries", "1000", "--cleanup-grace-ms", "40", "--cleanup-timeout-ms", "8000", "--retry-delay-ms", "0"]))
    .toMatchObject({ kind: "kernel-profile", maxAttempts: 7, attemptTimeoutSeconds: 600, cacheMaxEntries: 1000, cleanupGraceMs: 40, cleanupTimeoutMs: 8000, retryDelayMs: 0 });
});
