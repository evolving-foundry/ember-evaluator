import { expect, test } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kernelProfile } from "../../src/plugins/benchmarks/operator/kernel/runtime/profile.js";
test("profiling records and applies explicit cache, retry and timeout options", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kernel-profile-options-"));
  try {
    const problem = join(dir, "p.py"), kernel = join(dir, "k.py"), out = join(dir, "result.json");
    await writeFile(problem, "pass\n"); await writeFile(kernel, "def kernel_function(x): return x\n");
    await kernelProfile({ problem, kernel, out, round: 1, msprofBin: join(dir, "absent-msprof"),
      cacheEnabled: false, maxAttempts: 1, attemptTimeoutSeconds: 7 });
    const raw = JSON.parse(await readFile(join(dir, "result.raw.json"), "utf8"));
    expect(raw.metadata.cacheRequested).toBe(false);
    expect(raw.metadata.cacheEnabled).toBe(false);
    expect(raw.metadata.retryPolicy).toEqual({ maxAttempts: 1, attemptTimeoutSeconds: 7 });
    expect(raw.status).toBe("failed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32')('cancelling profiling terminates the replay process tree before returning', async () => {
  const { chmod } = await import('node:fs/promises');
  const { setTimeout: delay } = await import('node:timers/promises');
  const dir = await mkdtemp(join(tmpdir(), 'kernel-profile-cancel-'));
  let child: number | undefined;
  try {
    const problem = join(dir, 'p.py'), kernel = join(dir, 'k.py'), msprof = join(dir, 'msprof'), pidFile = join(dir, 'child.pid');
    await writeFile(problem, 'pass\n'); await writeFile(kernel, 'def kernel_function(x): return x\n');
    await writeFile(msprof, `#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);\n`);
    await chmod(msprof, 0o755);
    const controller = new AbortController();
    const pending = kernelProfile({ problem, kernel, out: join(dir, 'out.json'), round: 1, msprofBin: msprof,
      cacheEnabled: false, maxAttempts: 1, attemptTimeoutSeconds: 5 }, { signal: controller.signal }).catch(error => error);
    for (let count = 0; count < 100; count++) {
      try { child = Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(10); }
    }
    expect(child).toBeTruthy(); controller.abort(); await pending;
    let running = true;
    for (let count = 0; count < 50 && running; count++) {
      try {
        process.kill(child!, 0);
        // Linux init may retain a zombie; it cannot execute kernels or hold device work.
        if (process.platform === 'linux') running = !(await readFile(`/proc/${child}/stat`, 'utf8')).split(') ')[1]?.startsWith('Z');
      } catch { running = false; }
      if (running) await delay(10);
    }
    expect(running).toBe(false);
  } finally {
    if (child) { try { process.kill(child, 'SIGKILL'); } catch {} }
    await rm(dir, { recursive: true, force: true });
  }
});

test('published kernel atoms resolve from their packaged directory without a source checkout', async () => {
  const { resolveAtomDir } = await import('../../src/plugins/benchmarks/operator/kernel/runtime/cli.js');
  const dir = await mkdtemp(join(tmpdir(), 'kernel-packaged-atoms-'));
  const previous = process.env.KERNEL_ATOM_DIR;
  delete process.env.KERNEL_ATOM_DIR;
  try {
    await writeFile(join(dir, 'precision.py'), '# packaged worker\n');
    expect(resolveAtomDir('profile', {}, dir)).toBe(dir);
  } finally {
    if (previous === undefined) delete process.env.KERNEL_ATOM_DIR; else process.env.KERNEL_ATOM_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});


test("metric parsing keeps actual zero and omits missing or non-finite cells", async () => {
  const { parseMsprofMetricsTable, rowsToMetrics } = await import("../../src/plugins/benchmarks/operator/kernel/msprof-csv.js");
  const dir = await mkdtemp(join(tmpdir(), "kernel-profile-metrics-"));
  try {
    await writeFile(join(dir, "PipeUtilization.csv"), "block_id,aiv_vec_ratio,aiv_scalar_ratio,aiv_mte2_ratio\n0,0.4,0,\n1,0.7,NaN,Infinity\n");
    await writeFile(join(dir, "L2Cache.csv"), "block_id\n0\n1\n");
    await writeFile(join(dir, "ResourceConflictRatio.csv"), "block_id\n0\n1\n");
    const rows = await parseMsprofMetricsTable(dir);
    expect(rows).toHaveLength(1); expect(rows[0]?.block_id).toBe("1");
    const metrics = rowsToMetrics(rows);
    expect(metrics["1"]).toEqual({ aiv_vec_ratio: 0.7 });
    expect(rowsToMetrics([{ block_id: "0", aiv_scalar_ratio: 0 }])["0"]).toEqual({ aiv_scalar_ratio: 0 });
    await rm(join(dir, "L2Cache.csv"));
    await expect(parseMsprofMetricsTable(dir)).rejects.toThrow(/No L2Cache/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("roofline leaves absent pipes unavailable rather than reporting zero utilization", async () => {
  const { analyzeRoofline } = await import("../../src/plugins/benchmarks/operator/kernel/roofline.js");
  const analysis = analyzeRoofline({ block0: { aiv_vec_ratio: 0.9 } });
  expect(analysis.vec_rate).toBe(0.9);
  expect(analysis.scalar_rate).toBeNull(); expect(analysis.mte2_rate).toBeNull();
  expect(analysis.warnings.join(" ")).toContain("Missing AIV");
});
