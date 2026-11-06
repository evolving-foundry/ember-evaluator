import { expect, test, vi } from "vitest";
import { inferDockerWorkdir } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/workdir.js";
import { waitTaskHealth } from "../../src/infrastructure/containers/healthcheck.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { validateStateProfile } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/compatibility.js";
import { validateTransferSpec } from "../../src/infrastructure/filesystem/workspace-transfer.js";

test("a runtime ancestor can be a cwd but cannot be an archive root", () => {
  expect(inferDockerWorkdir("FROM fixture\nWORKDIR /opt\n")).toBe("/opt");
  expect(() => validateStateProfile({ workdir: "/opt", extraPaths: [] })).toThrow("Unsafe state transfer root");
  expect(() => validateStateProfile({ workdir: "/workspace", extraPaths: ["/opt"] })).toThrow("Unsafe state transfer root");
  expect(() => validateTransferSpec({ kind: "workspace-archive", workdir: "/opt", extraPaths: [] }, "/opt")).toThrow("Unsafe state root");
  expect(() => validateTransferSpec({ kind: "artifacts", workdir: "/opt", paths: ["/opt/task/output"] }, "/opt")).not.toThrow();
});
test("WORKDIR is inferred outside heredoc bodies and inherited across stages", () => {
  expect(inferDockerWorkdir("FROM python AS base\nWORKDIR /app\nRUN python - <<'PY'\nWORKDIR /hidden-body\nPY\nFROM base\n")).toBe("/app");
  expect(inferDockerWorkdir("FROM python\nRUN <<-EOF\n\tWORKDIR /body\n\tEOF\nWORKDIR /workspace\n")).toBe("/workspace");
  expect(() => inferDockerWorkdir("FROM python\nRUN <<EOF\nWORKDIR /body\n")).toThrow("Cannot infer");
});
test("task healthchecks retry transient failure and propagate exhaustion/cancellation", async () => {
  let count = 0;
  const command = vi.fn<DockerCommand>(async () => { if (++count < 3) throw new Error("not ready"); return { stdout: "", stderr: "" }; });
  const health = { command: "test ready", intervalSeconds: 0.001, startIntervalSeconds: 0.001, timeoutSeconds: 1, startPeriodSeconds: 0, retries: 3 };
  await waitTaskHealth(command, "main", health, AbortSignal.timeout(1000));
  expect(command).toHaveBeenCalledTimes(3);
  const failing: DockerCommand = async () => { throw new Error("not ready"); };
  await expect(waitTaskHealth(failing, "main", health, AbortSignal.timeout(1000))).rejects.toThrow("3 attempts");
  await expect(waitTaskHealth(failing, "main", health, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
});
