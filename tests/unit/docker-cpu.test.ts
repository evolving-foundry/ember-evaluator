import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { constrainDockerCpus, cpuBudgetNodeOptions, cpuCountForBudget, CPU_VIEW_PATH,
  nodeCpuViewSource, parseCpuList, selectCpuSet } from "../../src/infrastructure/containers/cpu.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

const signal = () => new AbortController().signal;

test("parses sparse affinity lists and rejects malformed or oversized ranges", () => {
  expect(parseCpuList(" 2-4,8,10-11\n")).toEqual([2, 3, 4, 8, 10, 11]);
  expect(parseCpuList("4,2-4")).toEqual([2, 3, 4]);
  for (const value of ["", "0-", "-1", "5-2", "1;echo x", "0-65536", "9999999999999999"])
    expect(() => parseCpuList(value)).toThrow();
});

test("preserves fractional quotas while choosing enough visible CPUs", () => {
  expect(cpuCountForBudget(0.5)).toBe(1);
  expect(cpuCountForBudget(1.5)).toBe(2);
  for (const value of [0, -1, NaN, Infinity, 65_537]) expect(() => cpuCountForBudget(value)).toThrow();
  expect(() => selectCpuSet("8,10", 3, "task")).toThrow("only 2");
});

test("spreads identities within the actual allowed CPU IDs instead of hardcoding 0,1", () => {
  const sets = new Set<string>();
  for (let index = 0; index < 20; index++) {
    const result = selectCpuSet("8-11,16-19", 2, `container-${index}`);
    expect(parseCpuList(result)).toHaveLength(2);
    expect(parseCpuList(result).every(id => [8, 9, 10, 11, 16, 17, 18, 19].includes(id))).toBe(true);
    expect(result).toBe(selectCpuSet("8-11,16-19", 2, `container-${index}`));
    sets.add(result);
  }
  expect(sets.size).toBeGreaterThan(1);
});

test("preserves image NODE_OPTIONS and honors the explicit container override", async () => {
  const command = vi.fn<DockerCommand>().mockResolvedValue({ stdout: '["PATH=/bin","NODE_OPTIONS=--no-warnings"]', stderr: "" });
  expect(await cpuBudgetNodeOptions(command, "image", undefined, signal())).toBe(`--require=${CPU_VIEW_PATH} --no-warnings`);
  expect(await cpuBudgetNodeOptions(command, "image", "--enable-source-maps", signal())).toBe(`--require=${CPU_VIEW_PATH} --enable-source-maps`);
  expect(await cpuBudgetNodeOptions(command, "image", "", signal())).toBe(`--require=${CPU_VIEW_PATH}`);
  expect(command).toHaveBeenCalledTimes(1);
});

test("confirms affinity and both Node views after updating only this container", async () => {
  const calls: string[][] = [];
  let selected = "";
  const command: DockerCommand = async args => {
    calls.push(args);
    if (args[0] === "update") selected = args[2] ?? "";
    return { stdout: calls.length === 1 ? "8-11\n" : calls.length === 3
      ? JSON.stringify({ available: 2, cpus: 2, allowed: selected }) : "", stderr: "" };
  };
  const result = await constrainDockerCpus(command, "container", 2, signal());
  expect(result).toEqual({ cpusetCpus: selected, availableCpus: 2 });
  expect(calls[1]).toEqual(["update", "--cpuset-cpus", selected, "container"]);
});

test("does not accept unchanged host visibility or proceed after parent cancellation", async () => {
  const command: DockerCommand = async args => ({ stdout: args[0] === "update" ? "" : args.at(-1)?.includes("available:")
    ? JSON.stringify({ available: 256, cpus: 256, allowed: "0-255" }) : "0-255", stderr: "" });
  await expect(constrainDockerCpus(command, "container", 2, signal())).rejects.toMatchObject({ code: "ENV_CPU_BUDGET_FAILED" });
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  const unused = vi.fn<DockerCommand>();
  await expect(constrainDockerCpus(unused, "container", 2, controller.signal)).rejects.toThrow("cancelled");
  expect(unused).not.toHaveBeenCalled();
});

test("Node CPU view caps legacy CJS and named ESM exports to affinity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpu-view-test-"));
  try {
    const file = join(directory, "cpu-view.cjs");
    await writeFile(file, nodeCpuViewSource);
    const script = `const os=require("node:os");os.cpus=()=>Array.from({length:256},()=>({model:"cpu"}));`
      + `os.availableParallelism=()=>2;require(process.argv[1]);`
      + `import("node:os").then(m=>console.log(JSON.stringify([os.cpus().length,m.cpus().length,m.default.cpus().length])));`;
    const result = await promisify(execFile)(process.execPath, ["-e", script, file]);
    expect(JSON.parse(result.stdout)).toEqual([2, 2, 2]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
