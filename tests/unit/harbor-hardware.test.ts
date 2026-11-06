import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { writeFixture } from "../fixtures/dataset-tasks.js";
import { loadGenericHarborTask } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/task.js";
import { parseHarborConfig } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/config.js";
import { HarborBenchmark } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/harbor-benchmark.js";
import { HarborShellVerifier } from "../../src/plugins/verifiers/shell.js";
import type { HardwareKind } from "../../src/core/contracts/hardware.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(environment: string, extra = "", compose?: string) {
  const root = await mkdtemp(join(tmpdir(), "harbor-hardware-")); roots.push(root);
  await writeFixture(root, {
    "task.toml": `[environment]\ndocker_image="fixture:latest"\nworkdir="/workspace"\n${environment}\n${extra}`,
    "instruction.md": "Solve the task.\n", "tests/test.sh": "true\n",
    ...(compose === undefined ? {} : { "environment/compose.yaml": compose }),
  });
  return root;
}
const load = (root: string, hardware: HardwareKind) => loadGenericHarborTask(root, root, "task-1", parseHarborConfig({}), new HarborShellVerifier(), AbortSignal.timeout(5000), {}, hardware);

test.each(["gpu=true", "gpus=1", 'gpu_types=["A100"]'])("GPU requirement %s distinguishes hardware mismatch from unsupported backend", async declaration => {
  const root = await fixture(declaration);
  await expect(load(root, "npu")).rejects.toMatchObject({ code: "BENCHMARK_UNSUPPORTED", message: expect.stringMatching(/Task task-1 environment.*requires GPU.*hardware=npu.*mismatch/) });
  await expect(load(root, "gpu")).rejects.toMatchObject({ code: "BENCHMARK_UNSUPPORTED", message: expect.stringMatching(/Task task-1 environment.*hardware=gpu.*not implemented/) });
});

test.each(['gpu="yes"', "gpus=-1", "gpus=0.5", 'gpu_types="A100"', 'gpu_types=[""]'])("invalid GPU declaration %s is a task data error", async declaration => {
  const root = await fixture(declaration);
  await expect(load(root, "npu")).rejects.toMatchObject({ code: "TASK_DATA_INVALID" });
});

test.each(["npu", "gpu"] as const)("ordinary tasks prepare without accelerator requirements under %s", async hardware => {
  const root = await fixture("gpu=false\ngpus=0\ngpu_types=[]");
  const task = await load(root, hardware);
  expect(task.solveEnv.image).toBe("fixture:latest");
  expect(task.solveEnv.env).not.toHaveProperty("ASCEND_RT_VISIBLE_DEVICES");
});

test("separate verifier and multi-step tasks retain the hardware selection", async () => {
  const root = await fixture("", '[verifier]\nenvironment_mode="separate"\n[verifier.environment]\ngpus=1');
  await expect(load(root, "gpu")).rejects.toThrow(/verifier.environment.gpus.*hardware=gpu/);
  const multi = await fixture("", '[[steps]]\nname="first"\n[steps.verifier]\nenvironment_mode="separate"\n[steps.verifier.environment]\ngpus=1');
  await writeFixture(multi, { "steps/first/instruction.md": "First step", "steps/first/tests/test.sh": "true" });
  await expect(load(multi, "gpu")).rejects.toThrow(/verifier.environment.gpus.*hardware=gpu/);
});

test.each([
  "gpus: all", "runtime: nvidia", "deploy: {resources: {reservations: {devices: [{driver: nvidia, capabilities: [gpu]}]}}}",
])("Compose accelerator declaration %s never reaches container execution", async declaration => {
  const root = await fixture("", "", `services:\n  main:\n    ${declaration}\n`);
  await expect(load(root, "npu")).rejects.toMatchObject({ code: "BENCHMARK_UNSUPPORTED", message: expect.stringMatching(/Task task-1 environment compose.services.main.*hardware=npu/) });
  await expect(load(root, "gpu")).rejects.toThrow(/hardware=gpu.*not implemented/);
});

test("directory benchmark passes hardware through source locking and preparation", async () => {
  const taskRoot = await fixture("gpus=1");
  const config = parseHarborConfig({ source: { kind: "local", path: taskRoot }, tasks: { root: ".", id: "directory" } });
  // Direct source loading is covered above; use a directory containing one task here.
  const parent = await mkdtemp(join(tmpdir(), "harbor-hardware-source-")); roots.push(parent);
  await writeFixture(parent, { "one/task.toml": '[environment]\ndocker_image="fixture"\nworkdir="/workspace"\ngpus=1', "one/instruction.md": "Solve", "one/tests/test.sh": "true" });
  config.source = { kind: "local", path: parent };
  config.cacheDir = join(taskRoot, "cache");
  const benchmark = new HarborBenchmark(config, undefined, undefined, {}, "gpu");
  const signal = AbortSignal.timeout(5000);
  const source = await benchmark.resolveSource(null, signal);
  const refs = [];
  for await (const ref of benchmark.enumerate(source, signal)) refs.push(ref);
  expect(refs).toHaveLength(1);
  const ref = refs[0]; if (!ref) throw new Error("Missing fixture task");
  await expect(benchmark.prepare(ref, source, signal)).rejects.toThrow(/hardware=gpu.*not implemented/);
});
