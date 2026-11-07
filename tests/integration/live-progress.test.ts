import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { DockerBuildCache } from "../../src/infrastructure/containers/build-cache.js";
import { observeDockerCommand, withDockerActivity } from "../../src/infrastructure/containers/progress.js";
import { LiveOperation } from "../../src/core/progress/live-progress.js";
import { consumePiRunner } from "../../src/runtimes/pi/process.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";
import type { ComponentActivity } from "../../src/core/contracts/activity.js";
import { RayControl } from "../../src/infrastructure/ray/control.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("Docker process output arrives before command completion and retains its result tail", async () => {
  let completed = false;
  const received = Promise.withResolvers<void>();
  const output: string[] = [];
  const pending = runDockerCommand(process.execPath, ["-e", "process.stdout.write('layer downloading\\n');setTimeout(()=>process.stderr.write('extracted\\n'),100)"], {
    onOutput(stream, bytes) {
      output.push(`${stream}:${Buffer.from(bytes).toString('utf8')}`);
      expect(completed).toBe(false); received.resolve();
    },
  }).then(value => { completed = true; return value; });
  await received.promise; expect(completed).toBe(false);
  const result = await pending;
  expect(result.stdout).toContain("layer downloading"); expect(result.stderr).toContain("extracted");
  expect(output).toHaveLength(2);
});

test("a Docker output observer error rejects the command and releases its process", async () => {
  await expect(runDockerCommand(process.execPath, ["-e", "process.stdout.write('output');setInterval(()=>{},1000)"], {
    onOutput() { throw new Error("observer failure"); },
  })).rejects.toThrow("observer failure");
});

test("Docker split UTF-8/credentials and no-newline chunks report real activity without exposing partial secrets", async () => {
  const events: ProgressEvent[] = [];
  const operation = new LiveOperation(event => events.push(event), { phase: "prepare", message: "镜像准备" }, ["fixture-secret"]);
  const gate = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>();
  const command = observeDockerCommand(async (_args, options) => {
    const bytes = Buffer.from("下载中 fixture-secret\n");
    options?.onOutput?.("stderr", bytes.subarray(0, 2));
    options?.onOutput?.("stderr", bytes.subarray(2, 16));
    first.resolve(); await gate.promise;
    options?.onOutput?.("stderr", bytes.subarray(16));
    return { stdout: "", stderr: bytes.toString("utf8") };
  });
  const pending = withDockerActivity(operation.activity, () => command(["pull", "image"]));
  await first.promise;
  expect(events.some(event => event.live?.status === "updated")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("fixture-se");
  gate.resolve(); await pending; operation.finish();
  expect(JSON.stringify(events)).toContain("下载中 [redacted]");
  expect(JSON.stringify(events)).not.toContain("fixture-secret");
});

test("shared builds multicast activity and one cancelled waiter does not stop another", async () => {
  const cache = new DockerBuildCache<string>();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const a = new AbortController(); const b = new AbortController();
  const first: ComponentActivity[] = []; const second: ComponentActivity[] = [];
  const command = observeDockerCommand(async (_args, options) => {
    started.resolve(); await gate.promise;
    options?.onOutput?.("stdout", Buffer.from("layer extracted\n"));
    return { stdout: "", stderr: "" };
  });
  const one = withDockerActivity(event => first.push(event), () => cache.get("same-image", a.signal, async signal => {
    await command(["build", "."], { signal }); return "image";
  }));
  await started.promise;
  const two = withDockerActivity(event => second.push(event), () => cache.get("same-image", b.signal, async () => { throw new Error("must share"); }));
  expect(second[0]?.message).toBe("Waiting for a shared image build");
  const cancelled = expect(one).rejects.toBeDefined(); a.abort(); await cancelled;
  gate.resolve(); expect(await two).toBe("image");
  expect(second.some(event => event.lines?.includes("layer extracted"))).toBe(true);
  expect(first.some(event => event.lines?.includes("layer extracted"))).toBe(false);
});

test("Pi nonterminal messages are observed during execution and are absent from stderr evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-pi-")); directories.push(root); await mkdir(join(root, "agent"));
  const gate = Promise.withResolvers<void>(); const observed = Promise.withResolvers<void>();
  const activities: ComponentActivity[] = [];
  const handle = {
    stdout: (async function* () {
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, type: "activity", activity: { message: "工具执行中", lines: ["fixture-secret"] } }) + "\n");
      yield bytes.subarray(0, 75); yield bytes.subarray(75);
      await gate.promise;
      yield Buffer.from(JSON.stringify({ schemaVersion: 1, type: "result", result: { finalText: "ok", usage: { inputTokens: null, outputTokens: null, totalTokens: null } } }) + "\n");
    })(),
    stderr: (async function* () { yield Buffer.from("existing stderr\n"); })(),
    done: gate.promise.then(() => ({ code: 0, signal: null })), stop: async () => {},
  };
  const stderr = join(root, "agent", "stderr.log");
  const pending = consumePiRunner(handle, "fixture-secret", stderr, new AbortController().signal, undefined, event => { activities.push(event); observed.resolve(); });
  await observed.promise; expect(activities).toEqual([{ message: "工具执行中", lines: ["[redacted]"] }]);
  gate.resolve(); expect((await pending).finalText).toBe("ok");
  expect(await readFile(stderr, "utf8")).toBe("existing stderr\n");
});

test("Ray progress checks node ownership, deduplicates and cannot mutate the heartbeat/result channel", async () => {
  const events: ProgressEvent[] = []; let updates = 0;
  const control = new RayControl({ default: { model: { name: "model", endpoint: null, api: "openai-completions", provider: null }, auth: { value: "fixture-secret", reference: null } } }, async () => { updates++; }, event => events.push(event));
  const key = { runId: "run", taskId: "task", attemptId: "attempt" };
  control.register(key, "digest", {});
  try {
    await control.handle("runtime", { key, nodeId: "node", hostname: "host", packageDigest: "digest", pluginVersions: {} });
    const values: ProgressEvent[] = [];
    const operation = new LiveOperation(event => values.push(event), { phase: "solve", message: "fixture-secret" });
    const snapshot = { schemaVersion: 1, publisherId: "source", sequence: 1, events: values };
    await expect(control.handle("progress", { key, nodeId: "wrong", snapshot })).rejects.toThrow("handshake");
    const before = control.lastSeen(key); const count = updates;
    await control.handle("progress", { key, nodeId: "node", snapshot });
    await control.handle("progress", { key, nodeId: "node", snapshot });
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ taskId: "task", attemptId: "attempt", message: "[redacted]" });
    expect(control.lastSeen(key)).toBe(before); expect(updates).toBe(count);
    control.finishProgress(key, "failed");
    expect(events.at(-1)?.live?.status).toBe("failed");
    await control.handle("progress", { key, nodeId: "node", snapshot });
    expect(events).toHaveLength(2);
    await expect(control.handle("progress", { key, nodeId: "node", snapshot: {} })).rejects.toThrow();
    await expect(control.handle("control", { key, nodeId: "node", state: "running" })).resolves.toEqual({ cancelled: false });
    operation.finish();
  } finally { control.close(); }
});
