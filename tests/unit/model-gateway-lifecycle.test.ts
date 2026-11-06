import { afterEach, expect, test, vi } from "vitest";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { createModelGateway, startModelForwarder } from "../../src/infrastructure/network/model-gateway.js";
const id = "a".repeat(64);
const output = { stdout: "", stderr: "" };
afterEach(() => vi.useRealTimers());

test("allows one emulated Node probe to start after 5s without killing and relaunching it", async () => {
  vi.useFakeTimers();
  let probes = 0;
  const command: DockerCommand = async (args, options) => {
    if (args.includes("-e")) {
      probes++;
      await new Promise<void>((resolve, reject) => {
        setTimeout(resolve, 6_000);
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    }
    return output;
  };
  const result = startModelForwarder(command, id, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(6_000);
  await result;
  expect(probes).toBe(1);
});

test("cancels an in-flight gateway probe with the parent signal", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const command: DockerCommand = async (args, options) => {
    if (args.includes("-e")) {
      started.resolve();
      await new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
    }
    return output;
  };
  const result = startModelForwarder(command, id, controller.signal);
  const assertion = expect(result).rejects.toThrow("cancelled");
  await started.promise;
  controller.abort(new Error("cancelled"));
  await assertion;
});

test("gateway uses an init process and confirms asynchronous removal before deleting its socket volume", async () => {
  const calls: string[][] = [];
  const command: DockerCommand = async args => {
    calls.push(args);
    if (args[0] === "create") return { stdout: id, stderr: "" };
    if (args[0] === "rm") throw new Error("lost removal response");
    if (args[0] === "container") throw new Error("No such container: " + id);
    return output;
  };
  const gateway = await createModelGateway(command, {
    endpoint: "https://example.com/v1", key: { runId: "r", taskId: "t", attemptId: "a" },
    phase: "solve", signal: new AbortController().signal,
  });
  await gateway.dispose();
  expect(calls.find(args => args[0] === "create")).toContain("--init");
  expect(calls.findIndex(args => args[0] === "container")).toBeLessThan(calls.findLastIndex(args => args[0] === "volume"));
});

test("invalid allowlist rules do not allocate a gateway", async () => {
  const command = vi.fn<DockerCommand>();
  await expect(createModelGateway(command, {
    allowedHosts: ["https://pypi.org"], key: { runId: "r", taskId: "t", attemptId: "a" },
    phase: "solve", signal: new AbortController().signal,
  })).rejects.toThrow(/allowedHosts/);
  expect(command).not.toHaveBeenCalled();
});

test("cancellation after gateway creation removes the partial container and volume", async () => {
  const controller = new AbortController();
  const calls: string[][] = [];
  const command: DockerCommand = async args => {
    calls.push(args);
    if (args[0] === "create") return { stdout: id, stderr: "" };
    if (args.includes("-e")) { controller.abort(new Error("cancelled")); throw controller.signal.reason; }
    return output;
  };
  await expect(createModelGateway(command, {
    allowedHosts: ["pypi.org"], key: { runId: "r", taskId: "t", attemptId: "a" },
    phase: "solve", signal: controller.signal,
  })).rejects.toThrow("cancelled");
  expect(calls.some(args => args[0] === "rm" && args.includes(id))).toBe(true);
  expect(calls.at(-1)?.slice(0, 3)).toEqual(["volume", "rm", "--force"]);
});

test("repeated gateway disposal shares one cleanup operation", async () => {
  const calls: string[][] = [];
  const command: DockerCommand = async args => {
    calls.push(args);
    return args[0] === "create" ? { stdout: id, stderr: "" } : output;
  };
  const gateway = await createModelGateway(command, {
    allowedHosts: [], key: { runId: "r", taskId: "t", attemptId: "a" },
    phase: "solve", signal: new AbortController().signal,
  });
  const first = gateway.dispose();
  expect(gateway.dispose()).toBe(first);
  await first;
  expect(calls.filter(args => args[0] === "rm")).toHaveLength(1);
});

test("stopping egress preserves its mounted volume until final disposal", async () => {
  const calls: string[][] = [];
  const command: DockerCommand = async args => {
    calls.push(args);
    return args[0] === "create" ? { stdout: id, stderr: "" } : output;
  };
  const gateway = await createModelGateway(command, {
    allowedHosts: [], key: { runId: "r", taskId: "t", attemptId: "a" },
    phase: "solve", signal: new AbortController().signal,
  });
  const initialRemovals = calls.filter(args => args[0] === "volume" && args[1] === "rm").length;
  await gateway.stop();
  expect(calls.filter(args => args[0] === "volume" && args[1] === "rm")).toHaveLength(initialRemovals);
  await gateway.dispose();
  expect(calls.filter(args => args[0] === "rm")).toHaveLength(1);
  expect(calls.filter(args => args[0] === "volume" && args[1] === "rm")).toHaveLength(initialRemovals + 1);
});

test("a failed final volume removal is reported as cleanup failure", async () => {
  let removals = 0;
  const command: DockerCommand = async args => {
    if (args[0] === "volume" && args[1] === "rm" && ++removals > 1) throw new Error("volume is still in use");
    return args[0] === "create" ? { stdout: id, stderr: "" } : output;
  };
  const gateway = await createModelGateway(command, {
    allowedHosts: [], key: { runId: "r", taskId: "t", attemptId: "a" },
    phase: "solve", signal: new AbortController().signal,
  });
  await expect(gateway.dispose()).rejects.toThrow(/CLEANUP_FAILED.*gateway volume/u);
});
