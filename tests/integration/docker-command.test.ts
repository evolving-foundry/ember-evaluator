import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { runDockerCommand } from "../../src/infrastructure/containers/command.js";

test("stdout and stderr stay independent of output observer mutations", async () => {
  const observed = new Set<string>();
  const result = await runDockerCommand(process.execPath, ["-e", "process.stdout.write(\"output\"); process.stderr.write(\"diagnostic\");"], {
    onOutput(stream, chunk) {
      observed.add(stream);
      chunk.fill(120);
    },
  });
  expect(result).toEqual({ stdout: "output", stderr: "diagnostic" });
  expect(observed).toEqual(new Set(["stdout", "stderr"]));
});

// Stands in for docker.exe running a CLI plugin: the "plugin" inherits the
// client's stdout/stderr and outlives it unless the whole tree is stopped.
// `detached` keeps Node's Windows kill-on-close job from ending the plugin with
// the client, which docker.exe (not a Node process) does not do either.
const CLIENT = String.raw`
const { spawn } = require("node:child_process");
const [plugin, pidFile, mode] = process.argv.slice(1);
spawn(process.execPath, ["-e", plugin, pidFile, mode, String(process.pid)], {
  detached: true,
  windowsHide: true,
  stdio: ["ignore", "inherit", "inherit"],
});
if (mode === "stay") setInterval(() => {}, 1000);
else process.exit(0);
`;

// Reports its PID once it is running; in "exit" mode only after the client is
// gone, so cancellation happens while the plugin alone holds the pipes.
const PLUGIN = String.raw`
const { writeFileSync } = require("node:fs");
const [pidFile, mode, client] = process.argv.slice(1);
setTimeout(() => {}, 60000);
const report = () => writeFileSync(pidFile, String(process.pid));
if (mode === "stay") report();
else {
  const timer = setInterval(() => {
    try { process.kill(Number(client), 0); } catch { clearInterval(timer); report(); }
  }, 20);
}
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function cancelWithPlugin(mode: "stay" | "exit"): Promise<{ plugin: number; command: Promise<unknown> }> {
  const root = await mkdtemp(join(tmpdir(), "evaluator-docker-command-"));
  const pidFile = join(root, "plugin.pid");
  const controller = new AbortController();
  const command = runDockerCommand(process.execPath, ["-e", CLIENT, PLUGIN, pidFile, mode], {
    signal: controller.signal,
  });
  command.catch(() => {});
  try {
    for (let waited = 0; ; waited += 50) {
      const text = await readFile(pidFile, "utf8").catch(() => "");
      if (text !== "") {
        controller.abort();
        return { plugin: Number.parseInt(text, 10), command };
      }
      if (waited > 10_000) throw new Error("fake Docker plugin did not start");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("cancellation returns while an orphaned client descendant still holds the pipes", async () => {
  const { plugin, command } = await cancelWithPlugin("exit");
  try {
    await expect(command).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    if (alive(plugin)) process.kill(plugin);
  }
}, 20_000);

test.skipIf(process.platform !== "win32")("cancellation on Windows stops the client's descendants", async () => {
  const { plugin, command } = await cancelWithPlugin("stay");
  try {
    await expect(command).rejects.toMatchObject({ name: "AbortError" });
    expect(alive(plugin)).toBe(false);
  } finally {
    if (alive(plugin)) process.kill(plugin);
  }
}, 20_000);
