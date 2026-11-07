import { expect, test } from "vitest";
import { removeDockerContainer, stopDockerContainer } from "../../src/infrastructure/containers/cleanup.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

const id = "a".repeat(64);
const output = { stdout: "", stderr: "" };
const limits = { commandMs: 10, inspectMs: 10, retryDelayMs: 1 };

test("stops the namespace with a grace period before deleting it", async () => {
  const calls: string[][] = [];
  const command: DockerCommand = async args => { calls.push(args); return output; };
  await removeDockerContainer(command, id, new AbortController().signal);
  expect(calls).toEqual([["stop", "--time", "2", id], ["rm", "--force", id]]);
});

test("confirms deletion when a timed-out Docker client lost the response", async () => {
  const calls: string[][] = [];
  const command: DockerCommand = async (args, options) => {
    calls.push(args);
    if (args[0] === "rm") return await new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    });
    if (args[0] === "container") throw new Error(`Error: No such container: ${id}`);
    return output;
  };
  await removeDockerContainer(command, id, new AbortController().signal, limits);
  expect(calls.filter(args => args[0] === "rm")).toHaveLength(1);
  expect(calls.some(args => args[0] === "container")).toBe(true);
});

test("retries removal of a container still being removed", async () => {
  let removals = 0;
  const command: DockerCommand = async args => {
    if (args[0] === "rm" && ++removals === 1) throw new Error("removal is already in progress");
    return output;
  };
  await removeDockerContainer(command, id, new AbortController().signal, limits);
  expect(removals).toBe(2);
});

test("does not mistake unavailable Docker for confirmed removal", async () => {
  const command: DockerCommand = async () => { throw new Error("Cannot connect to the Docker daemon"); };
  await expect(removeDockerContainer(command, id, new AbortController().signal, limits))
    .rejects.toMatchObject({ code: "CLEANUP_FAILED", message: expect.stringContaining(id) });
});

test("fails if the container still exists after all removal attempts", async () => {
  let removals = 0;
  const command: DockerCommand = async args => {
    if (args[0] === "rm") { removals++; throw new Error("permission denied"); }
    return output;
  };
  await expect(removeDockerContainer(command, id, new AbortController().signal, limits)).rejects.toThrow("Cannot confirm removal");
  expect(removals).toBe(8);
});

test("allows an asynchronous daemon removal to settle beyond the first three replies", async () => {
  let confirmations = 0;
  const command: DockerCommand = async args => {
    if (args[0] === "rm") throw new Error("removal of container is already in progress");
    if (args[0] === "container" && ++confirmations === 4) throw new Error(`No such container: ${id}`);
    return output;
  };
  await removeDockerContainer(command, id, new AbortController().signal, limits);
  expect(confirmations).toBe(4);
});

test("honors cancellation before starting cleanup", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let calls = 0;
  const command: DockerCommand = async () => { calls++; return output; };
  await expect(removeDockerContainer(command, id, controller.signal)).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
});

test("reconciles a failed stop response with an exited PID namespace", async () => {
  const command: DockerCommand = async args => {
    if (args[0] === "stop") throw new Error("tried to kill container, but did not receive an exit event");
    return { stdout: JSON.stringify({ Running: false, Pid: 0, Status: "exited" }), stderr: "" };
  };
  await stopDockerContainer(command, id, new AbortController().signal, limits);
});

test("retries stopping while the daemon still reports a running namespace", async () => {
  let stops = 0;
  const command: DockerCommand = async args => {
    if (args[0] === "stop" && ++stops < 2) throw new Error("lost exit event");
    return { stdout: JSON.stringify({ Running: true, Pid: 123, Status: "running" }), stderr: "" };
  };
  await stopDockerContainer(command, id, new AbortController().signal, limits);
  expect(stops).toBe(2);
});

test("never confirms a running namespace or an unavailable daemon as stopped", async () => {
  const command: DockerCommand = async args => {
    if (args[0] === "stop") throw new Error("lost exit event");
    return { stdout: JSON.stringify({ Running: true, Pid: 123, Status: "running" }), stderr: "" };
  };
  await expect(stopDockerContainer(command, id, new AbortController().signal, limits)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
  await expect(stopDockerContainer(async () => { throw new Error("daemon offline"); }, id,
    new AbortController().signal, limits)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
});
