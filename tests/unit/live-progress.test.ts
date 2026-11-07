import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CliLiveProgress } from "../../src/cli/live-progress.js";
import { LIVE_LINES, LiveOperation, ProgressSnapshots, safeLiveText, toolOutputLines } from "../../src/core/progress/live-progress.js";
import { parseProgressSnapshot, ProgressPublisher } from "../../src/core/progress/progress-wire.js";
import { JobsProgressMailbox } from "../../src/infrastructure/ray/jobs-progress.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";
import { progressOperation } from "../../src/core/progress/progress-operation.js";
import { parseRunnerOutput } from "../../src/runtimes/pi/protocol.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function clock() { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] }); }

/** Terminal screen behavior, rather than snapshots of the renderer's escape strings. */
class Screen extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 36;
  private row = 0;
  private cells: string[] = [""];
  writes = 0;
  write(text: string): boolean {
    this.writes++;
    const chunks = text.split(/(\x1b\[[0-9;]*[A-Za-z]|\r|\n)/u);
    for (const chunk of chunks) {
      if (chunk === "\r") continue;
      if (chunk === "\n") { this.row++; this.cells[this.row] ??= ""; continue; }
      if (chunk.startsWith("\x1b[")) {
        if (chunk.endsWith("A")) this.row = Math.max(0, this.row - Number(chunk.slice(2, -1) || "1"));
        if (chunk.endsWith("J")) { this.cells.length = this.row + 1; this.cells[this.row] = ""; }
        continue;
      }
      this.cells[this.row] = (this.cells[this.row] ?? "") + chunk;
    }
    return true;
  }
  text(): string { return this.cells.join("\n"); }
  stream(): NodeJS.WriteStream { return this as unknown as NodeJS.WriteStream; }
}
const event = (id: string, status: "started" | "updated" | "completed" | "failed" = "started", sequence = 1): ProgressEvent => ({
  phase: "solve", message: "正在运行工具", taskId: id, taskNumber: 1, taskTotal: 2, transient: true,
  live: { id, status, sequence, elapsedMs: 1000, idleMs: 1000, lines: [`${id} 最近输出`] },
});

test("source elapsed survives updates; capability notifications and repeated snapshots do not reset idle", () => {
  clock(); const events: ProgressEvent[] = [];
  const operation = new LiveOperation(e => events.push(e), { phase: "solve", message: "正在解题" }, ["fixture-key"]);
  vi.advanceTimersByTime(20_000);
  operation.update({ lines: ["done fixture-key"] });
  vi.advanceTimersByTime(40_000);
  operation.update({ message: "当前执行器不提供细节", activity: false });
  expect(events.at(-1)?.live).toMatchObject({ elapsedMs: 60_000, idleMs: 40_000, lines: ["done [redacted]"] });
  const state = new ProgressSnapshots(); state.observe(events.at(-1)!);
  vi.advanceTimersByTime(15_000); state.observe(events.at(-1)!);
  expect(state.snapshot()[0]?.live?.idleMs).toBe(55_000);
  operation.finish(); const count = events.length; operation.activity({ message: "late" }); operation.finish();
  expect(events).toHaveLength(count);
});

test("concurrent screen removes successful tails, retains failed evidence, and cannot restart after close", () => {
  clock(); const screen = new Screen();
  const panel = new CliLiveProgress(screen.stream(), text => screen.write(text + "\n"), false);
  panel.observe(event("A")); panel.observe(event("B")); vi.advanceTimersByTime(200);
  expect(screen.text()).toContain("A 最近输出"); expect(screen.text()).toContain("B 最近输出");
  panel.observe(event("A", "completed", 2)); vi.advanceTimersByTime(200);
  expect(screen.text()).not.toContain("A 最近输出"); expect(screen.text()).toContain("✓");
  panel.observe(event("A", "updated", 3));
  panel.write(() => screen.write("正式日志\n"));
  panel.observe(event("B", "failed", 2)); vi.advanceTimersByTime(200);
  expect(screen.text()).toContain("B 最近输出"); expect(screen.text()).toContain("正式日志");
  panel.close(); const count = screen.writes;
  panel.observe(event("late")); vi.advanceTimersByTime(100_000);
  expect(screen.writes).toBe(count); expect(screen.listenerCount("resize")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("English terminal labels count finished tasks and preserve original tool output", () => {
  clock(); const screen = new Screen();
  const panel = new CliLiveProgress(screen.stream(), text => screen.write(text + "\n"), false);
  panel.observe({ phase: "task", taskId: "finished", taskTotal: 2, message: "Finished: completed; score=1; progress 1/2" });
  const active = event("active");
  active.message = "Running tool";
  active.live!.lines = [];
  panel.observe(active); vi.advanceTimersByTime(200);
  expect(screen.text()).toContain("Evaluation: ready 0/2");
  expect(screen.text()).toContain("completed 1/2");
  expect(screen.text()).toContain("Task 1/2 active");
  expect(screen.text()).not.toMatch(/\p{Script=Han}/u);
  panel.observe({ ...active, live: { ...active.live!, status: "updated", sequence: 2, lines: ["工具原始输出"] } });
  vi.advanceTimersByTime(200);
  expect(screen.text()).toContain("工具原始输出");
  panel.close();
});

test("source bytes and current planning task are visible on screen and disappear when their stage completes", async () => {
  clock();
  const screen = new Screen();
  const panel = new CliLiveProgress(screen.stream(), text => screen.write(text + "\n"), false);
  const signal = new AbortController().signal;
  const download = Promise.withResolvers<void>();
  const resolving = progressOperation(event => panel.observe(event), { phase: "source", message: "准备数据集 harbor" }, signal, async activity => {
    activity({ lines: ["下载 example.test：128.0 MiB / 512.0 MiB (25%)"] });
    await download.promise;
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(screen.text()).toContain("128.0 MiB / 512.0 MiB (25%)");
  download.resolve(); await resolving;
  await vi.advanceTimersByTimeAsync(200);
  expect(screen.text()).not.toContain("128.0 MiB");
  const preparing = Promise.withResolvers<void>();
  const planning = progressOperation(event => panel.observe(event), { phase: "prepare", message: "规划整批环境" }, signal, async activity => {
    activity({ message: "规划任务 15/66 formal-crypto", lines: ["准备任务文件 3/8"] });
    await preparing.promise;
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(screen.text()).toContain("规划任务 15/66 formal-crypto");
  expect(screen.text()).toContain("准备任务文件 3/8");
  preparing.resolve(); await planning;
  await vi.advanceTimersByTimeAsync(200);
  expect(screen.text()).not.toContain("准备任务文件 3/8");
  panel.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("Chinese and emoji rows fit the terminal; idle timer changes without resetting elapsed", () => {
  clock(); const screen = new Screen(); screen.columns = 90;
  const panel = new CliLiveProgress(screen.stream(), text => screen.write(text + "\n"), false);
  const value = event("正式测试😀中文路径/一段很长的任务名称");
  panel.observe(value); vi.advanceTimersByTime(61_000);
  const rows = screen.text().split("\n");
  expect(rows.some(line => line.includes("check activity"))).toBe(true);
  expect(rows.every(line => visibleWidth(line) < screen.columns)).toBe(true);
  screen.columns = 120; screen.emit("resize");
  expect(screen.text()).toContain("62s");
  panel.close();
});

test("ten preview lines survive buffering and transport, fit a 24-row terminal, and shrink on resize", () => {
  clock();
  const screen = new Screen(); screen.rows = 24;
  const panel = new CliLiveProgress(screen.stream(), text => screen.write(text + "\n"), false);
  const events: ProgressEvent[] = [];
  const operation = new LiveOperation(value => { events.push(value); panel.observe(value); }, { phase: "solve", message: "正在运行工具", taskId: "task" });
  const output = Array.from({ length: 14 }, (_, index) => `输出行${String(index).padStart(2, "0")}`);
  operation.activity({ lines: output });
  vi.advanceTimersByTime(200);
  const latest = events.at(-1);
  expect(latest?.live?.lines).toEqual(output.slice(-10));
  expect(toolOutputLines(output.join("\n"))).toEqual(output.slice(-10));
  for (const line of output.slice(-10)) expect(screen.text()).toContain(line);
  for (const line of output.slice(0, 4)) expect(screen.text()).not.toContain(line);
  expect(screen.text().split("\n")).toHaveLength(12);
  const snapshot = { schemaVersion: 1, publisherId: "fixture", sequence: 1, events: [latest] };
  expect(parseProgressSnapshot(snapshot).events[0]?.live?.lines).toHaveLength(10);
  expect(parseRunnerOutput({ schemaVersion: 1, type: "activity", activity: { lines: output.slice(-10) } })).toMatchObject({ activity: { lines: output.slice(-10) } });
  expect(() => parseRunnerOutput({ schemaVersion: 1, type: "activity", activity: { lines: output.slice(-11) } })).toThrow();
  expect(() => parseProgressSnapshot({ ...snapshot, events: [{ ...latest, live: { ...latest?.live, lines: output.slice(-11) } }] })).toThrow();
  screen.rows = 16; screen.emit("resize");
  expect(screen.text().split("\n")).toHaveLength(8);
  expect(screen.text()).not.toContain("输出行04");
  for (const line of output.slice(-6)) expect(screen.text()).toContain(line);
  operation.finish(); vi.advanceTimersByTime(200);
  for (const line of output) expect(screen.text()).not.toContain(line);
  const failed = new LiveOperation(value => panel.observe(value), { phase: "solve", message: "失败工具", taskId: "failed" });
  failed.activity({ lines: output }); failed.finish("failed");
  for (const line of output.slice(-5)) expect(screen.text()).toContain(line);
  expect(screen.text()).not.toContain("输出行08");
  panel.close(); expect(vi.getTimerCount()).toBe(0);
});

test("plain/CI/dumb terminals disable cursor rendering, NO_COLOR does not disable TTY", () => {
  const screen = new Screen();
  vi.stubEnv("TERM", "xterm"); vi.stubEnv("CI", "true");
  expect(CliLiveProgress.enabled("auto", screen.stream())).toBe(false);
  expect(CliLiveProgress.enabled("tty", screen.stream())).toBe(true);
  vi.stubEnv("TERM", "dumb"); expect(CliLiveProgress.enabled("tty", screen.stream())).toBe(false);
  vi.stubEnv("TERM", "xterm"); vi.stubEnv("CI", ""); vi.stubEnv("NO_COLOR", "1");
  expect(CliLiveProgress.enabled("auto", screen.stream())).toBe(true);
  expect(CliLiveProgress.enabled("plain", screen.stream())).toBe(false);
  screen.isTTY = false; expect(CliLiveProgress.enabled("tty", screen.stream())).toBe(false);
});

test("wire validation and gateway RAM reject malformed events and recover from duplicate/reordered snapshots", () => {
  clock(); const mailbox = new JobsProgressMailbox();
  const snapshot = { schemaVersion: 1, publisherId: "source", sequence: 2, events: [event("A", "updated", 2)] };
  mailbox.put("job", snapshot); mailbox.put("job", { ...snapshot, sequence: 1, events: [event("A")] });
  vi.advanceTimersByTime(12_000);
  expect(mailbox.get("job").events[0]?.live).toMatchObject({ sequence: 2, idleMs: 13_000 });
  expect(() => parseProgressSnapshot({ ...snapshot, events: [{ ...event("A"), live: { ...event("A").live, lines: ["x".repeat(2049)] } }] })).toThrow();
  mailbox.put("job", { ...snapshot, sequence: 3, ended: true, events: [event("A", "completed", 3)] });
  vi.advanceTimersByTime(60_001); expect(mailbox.get("job").publisherId).toBe("pending");
  mailbox.put("job", snapshot); expect(mailbox.get("job").events).toHaveLength(1);
});

test("publisher sends source ages, redacts before transport and tolerates transport rejection", async () => {
  clock(); const sent: unknown[] = [];
  const publisher = new ProgressPublisher(async snapshot => { sent.push(snapshot); throw new Error("offline"); }, ["fixture-key"]);
  publisher.observe({ ...event("A"), message: "fixture-key", live: { ...event("A").live!, lines: ["fixture-key"] } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(JSON.stringify(sent)).not.toContain("fixture-key");
  await publisher.close(); expect(vi.getTimerCount()).toBe(0);
});

test("redacts control sequences and credentials before UTF-8 truncation", () => {
  const text = safeLiveText("\x1b]0;spoofed-title\x07密钥 token=abc Bearer secret https://user:pass@example.test/a?key=123 " + "中".repeat(3000));
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
  expect(text).not.toContain("spoofed-title"); expect(text).not.toContain("secret"); expect(text).not.toContain("user:pass");
});

test("hours of idle redraws stop cleanly and preview bodies stay below the per-run budget", () => {
  clock(); const screen = new Screen();
  const panel = new CliLiveProgress(screen.stream(), text => screen.write(text + "\n"), false);
  panel.observe(event("long-running")); vi.advanceTimersByTime(2 * 60 * 60 * 1000);
  expect(screen.text()).toContain("7201s");
  panel.close(); expect(vi.getTimerCount()).toBe(0);
  const state = new ProgressSnapshots();
  for (let i = 0; i < 500; i++) {
    const value = event(String(i));
    value.live!.lines = Array.from({ length: LIVE_LINES }, () => `${i} ` + "x".repeat(2000));
    state.observe(value);
  }
  const snapshot = state.snapshot();
  const bytes = snapshot.reduce((sum, value) => sum + (value.live?.lines.reduce((total, line) => total + Buffer.byteLength(line), 0) ?? 0), 0);
  expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(snapshot[0]?.live?.lines).toEqual([]);
  expect(snapshot.at(-1)?.live?.lines).toHaveLength(LIVE_LINES);
});

test("a completed substep cannot reappear under a still running parent", () => {
  const events: ProgressEvent[] = [];
  const operation = new LiveOperation(value => events.push(value), { phase: "environment", message: "准备环境" });
  operation.activity({ operationId: "build", status: "started", message: "共享构建" });
  operation.activity({ operationId: "build", status: "completed" });
  const before = events.length;
  operation.activity({ operationId: "build", status: "updated", lines: ["late"] });
  expect(events).toHaveLength(before);
  expect(events.some(event => event.live?.parentId === operation.id && event.live.status === "completed")).toBe(true);
  operation.finish();
});
