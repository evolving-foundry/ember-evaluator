import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { NpuKernelBackend } from "../../src/plugins/benchmarks/operator/kernel/runtime/npu.js";
import { createKernelBackend } from "../../src/plugins/benchmarks/operator/kernel/runtime/backend.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";

const python = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
const available = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
test.skipIf(!available)("NPU timing honors the selected device and never probes CUDA or falls back to CPU", () => {
  const result = spawnSync(python, [resolve("tests/fixtures/kernel/check-npu-timing.py"), resolve("src/plugins/benchmarks/operator/kernel/runtime/timing.py")],
    { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.status, result.stderr).toBe(0);
});

test("NPU backend keeps device environment, packaged files and worker protocol", async () => {
  const backend = new NpuKernelBackend({ python: "fixture-python", device: 3, profiling: { enabled: false, roundNum: 1 } });
  expect(backend.environment()).toEqual({ ASCEND_VISIBLE_DEVICES: "3", ASCEND_RT_VISIBLE_DEVICES: "3", KERNEL_NPU_DEVICE: "0" });
  await Promise.all(backend.runtimeFiles().map(file => access(file.origin)));
  const root = await mkdtemp(join(tmpdir(), "kernel-npu-"));
  const response = { status: "incorrect", error: "fixture mismatch" };
  const start = vi.fn<EnvironmentSession["start"]>(async () => ({
    stdout: (async function* () { yield Buffer.from(JSON.stringify(response)); })(),
    stderr: (async function* () {})(), done: Promise.resolve({ code: 0, signal: null }), stop: async () => {},
  }));
  const session: EnvironmentSession = { id: "fixture", workdir: root, agentOutputDir: root, verifierOutputDir: root, metadata: null,
    start, upload: async () => {}, download: async () => {}, exportState: async () => { throw new Error("unexpected export"); },
    restoreState: async () => {}, dispose: async () => {} };
  const request = { candidateSha256: "a".repeat(64), referenceKind: "pytorch" };
  try {
    await writeFile(join(root, "kernel-result.json"), JSON.stringify(response));
    expect(await backend.execute(request, session, AbortSignal.timeout(5000))).toEqual(response);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ executable: "fixture-python",
      args: ["runtime/precision.py", "--output", join(root, "kernel-result.json")], input: Buffer.from(JSON.stringify(request)) }), expect.any(AbortSignal));
    expect(() => createKernelBackend("gpu", { python: "must-not-start", device: 0, profiling: { enabled: false, roundNum: 1 } })).toThrow(/GPU backend is not implemented/);
    expect(start).toHaveBeenCalledTimes(1);
    await writeFile(join(root, "kernel-result.json"), JSON.stringify({ ...response, error: "different evidence" }));
    await expect(backend.execute(request, session, AbortSignal.timeout(5000))).rejects.toThrow(/evidence differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
