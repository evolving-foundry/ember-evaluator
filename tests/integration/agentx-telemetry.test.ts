import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const python = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
const available = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
test.skipIf(!available)("Ascend telemetry uses bounded device queries, fresh evidence and cancellable resources", () => {
  const result = spawnSync(python, [resolve("tests/fixtures/agentx/check-telemetry.py"), resolve("src/runtimes/agentx/assets")],
    { encoding: "utf8", windowsHide: true, timeout: 20000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.status, result.stderr).toBe(0);
}, 25000);

test.skipIf(!available)("local multi-chip telemetry starts with the bridge, isolates failures and releases resources", () => {
  const result = spawnSync(python, [resolve("tests/fixtures/agentx/check-local-telemetry.py"), resolve("src/runtimes/agentx/assets")],
    { encoding: "utf8", windowsHide: true, timeout: 25000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.status, result.stderr).toBe(0);
}, 30000);
