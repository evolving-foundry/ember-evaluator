import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
const execute = promisify(execFile);
const script = String.raw`
import json, os, runpy, sys, types
module = runpy.run_path(sys.argv[1])
runner = module["run_node"]
runner.__globals__["PYTHON_VERSION"] = sys.version_info[:3]
sys.modules["ray"] = types.SimpleNamespace(__version__="2.58.0",
    get_runtime_context=lambda: types.SimpleNamespace(get_node_id=lambda: "worker-node"))
os.environ["EVALUATOR_NODE_CONFIG"] = sys.argv[2]
try:
    runner({"safeConfig": {"timeoutSeconds": 5}})
except module["RetiredNodeFailure"] as error:
    wrapped = type("RayTaskError", (Exception,), {})("sensitive exception text")
    wrapped.cause = error
    print(json.dumps({"code": module["error_code"](wrapped), "retired": True}))
`;

test.skipIf(!available).each([
  ["ENV_ARCH_UNSUPPORTED", "ENV_ARCH_UNSUPPORTED"],
  ["MODEL_AUTH_FAILED", "MODEL_AUTH_FAILED"],
  ["ENV_ARCH_UNSUPPORTED\nsecret", "RAY_WORKER_LOST"],
])("a retired Node worker transports only the stable error code %j", async (code, expected) => {
  const root = await mkdtemp(join(tmpdir(), "ray-node-error-"));
  try {
    const worker = join(root, "worker.cjs");
    await writeFile(worker, `process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(JSON.stringify({ errorCode: code }))}); process.exitCode = 1; });\n`);
    const config = join(root, "node.json");
    await writeFile(config, JSON.stringify({ nodeExecutable: process.execPath, workerEntry: worker }));
    const { stdout } = await execute(python, ["-c", script, resolve("src/infrastructure/ray/python/driver.py"), config], { timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual({ code: expected, retired: true });
    expect(stdout).not.toContain("secret");
    expect(stdout).not.toContain("sensitive");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

test.skipIf(!available)("successful Node responses preserve bounded runtime warnings across the Python bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "ray-node-warning-"));
  try {
    const warning = "Benchmark requires linux/amd64 on linux/arm64; QEMU may reduce performance";
    const response = { receipt: {}, nodeId: "worker-node", hostname: "host", warnings: [warning] };
    const worker = join(root, "worker.cjs");
    await writeFile(worker, `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(response))}));\n`);
    const config = join(root, "node.json");
    await writeFile(config, JSON.stringify({ nodeExecutable: process.execPath, workerEntry: worker }));
    const successful = script.slice(0, script.indexOf("try:\n")) + 'print(json.dumps(runner({"safeConfig": {"timeoutSeconds": 5}})))\n';
    const { stdout } = await execute(python, ["-c", successful, resolve("src/infrastructure/ray/python/driver.py"), config], { timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual(response);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

test.skipIf(!available)("preparation without a round deadline preserves environment budgets across the Python bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "ray-node-preparation-"));
  try {
    const timing = { solve: { baseSeconds: 600, concurrency: 32, multiplier: 10, timeoutSeconds: 6000,
      startedAt: "2026-10-30T00:00:00.000Z", deadlineAt: "2026-10-30T01:40:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z" } };
    const response = { preparationDigest: "a".repeat(64), nodeId: "worker-node", hostname: "host", environmentTimeouts: timing };
    const worker = join(root, "worker.cjs"), config = join(root, "node.json");
    await writeFile(worker, `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(response))}));\n`);
    await writeFile(config, JSON.stringify({ nodeExecutable: process.execPath, workerEntry: worker }));
    const setup = script.slice(0, script.indexOf("try:\n"));
    const payload = '{"preparation": {"mode": "prepare", "deadlineAt": None}, "safeConfig": {"timeoutSeconds": 5}}';
    const successful = setup + `print(json.dumps(runner(${payload})))\n`;
    expect(JSON.parse((await execute(python, ["-c", successful, resolve("src/infrastructure/ray/python/driver.py"), config], { timeout: 10_000 })).stdout)).toEqual(response);
    await writeFile(worker, `process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(${JSON.stringify(JSON.stringify({ errorCode: "ENV_PREPARATION_TIMEOUT", environmentTimeouts: timing }))}); process.exitCode = 1; });\n`);
    const failed = setup + `try:\n    runner(${payload})\nexcept module["RetiredNodeFailure"] as error:\n    print(json.dumps({"code": error.code, "timing": error.environment_timeouts}))\n`;
    expect(JSON.parse((await execute(python, ["-c", failed, resolve("src/infrastructure/ray/python/driver.py"), config], { timeout: 10_000 })).stdout))
      .toEqual({ code: "ENV_PREPARATION_TIMEOUT", timing });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
