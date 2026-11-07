import { expect, test, vi } from "vitest";
import { captureDockerLogOwnership, restoreDockerLogOwnership } from "../../src/infrastructure/containers/log-ownership.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

const signal = () => AbortSignal.timeout(5000);
const owners = [{ path: "/logs/agent", uid: 1000, gid: 1001, mode: 0o700 }, { path: "/logs/verifier", uid: 0, gid: 0, mode: 0o750 }];

test("captures log owners in the container's user namespace before solver writes", async () => {
  const command = vi.fn<DockerCommand>(async () => ({ stdout: JSON.stringify(owners), stderr: "" }));
  expect(await captureDockerLogOwnership(command, "fixture-id", owners.map(owner => owner.path), signal())).toEqual(owners);
  expect(command.mock.calls[0]?.[0].slice(0, 6)).toEqual(["exec", "--user", "0:0", "fixture-id", "node", "--input-type=module"]);
});

test.each([[], ["/workspace"], ["/logs/agent", "/logs/agent"], ["/logs/../workspace"]].map(paths => ({ paths })))(
  "rejects non-log or duplicate mounts before running privileged code: %j", async ({ paths }) => {
    const command = vi.fn<DockerCommand>();
    await expect(captureDockerLogOwnership(command, "fixture-id", paths, signal())).rejects.toThrow("Invalid Docker log mounts");
    expect(command).not.toHaveBeenCalled();
  },
);

test.each([
  {}, [], [{ path: "/logs/agent", uid: 1000, gid: 1000 }],
  [{ path: "/logs/verifier", uid: 1000, gid: 1000 }, owners[1]],
  [{ path: "/logs/agent", uid: -1, gid: 1000 }, owners[1]],
  [{ path: "/logs/agent", uid: 1000, gid: "1000" }, owners[1]],
].map(receipt => ({ receipt })))("rejects invalid ownership receipts instead of guessing host IDs: %j", async ({ receipt }) => {
  const command: DockerCommand = async () => ({ stdout: JSON.stringify(receipt), stderr: "" });
  await expect(captureDockerLogOwnership(command, "fixture-id", owners.map(owner => owner.path), signal())).rejects.toThrow("Invalid Docker log ownership receipt");
});

test("uses the captured owners for handoff and reports ownership failures", async () => {
  const command = vi.fn<DockerCommand>(async () => ({ stdout: "", stderr: "" }));
  const active = signal();
  await restoreDockerLogOwnership(command, "fixture-id", owners, active);
  expect(command.mock.calls[0]?.[0].at(-1)).toBe(JSON.stringify(owners));
  expect(command.mock.calls[0]?.[1]?.signal).toBe(active);
  command.mockRejectedValueOnce(new Error("ownership denied"));
  await expect(restoreDockerLogOwnership(command, "fixture-id", owners, active)).rejects.toThrow("ownership denied");
});
