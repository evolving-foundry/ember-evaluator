import { spawn, execFile } from "node:child_process";
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { expectRecord } from "../../core/validation/input.js";

type Device = { deviceId: number; chipId?: number };
export type HostNpuTarget = Device & { endpoint: string | null; errors: string[] };
export type HostNpuSampling = { targets: HostNpuTarget[]; finish(): Promise<HostNpuTarget[]> };
const execute = promisify(execFile);

class Channel {
  private buffer = "";
  private messages: unknown[] = [];
  private pending: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  private error: Error | undefined;
  constructor(readonly input: Writable, output: Readable, readonly destroy: () => void) {
    const fail = (error: Error) => { this.error = error; this.pending?.reject(error); this.pending = undefined; };
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 1024 * 1024) { fail(new Error("NPU sampling protocol exceeds its size limit")); destroy(); return; }
      let boundary: number;
      while ((boundary = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, boundary); this.buffer = this.buffer.slice(boundary + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (this.pending) { this.pending.resolve(value); this.pending = undefined; }
          else this.messages.push(value);
        } catch { fail(new Error("Malformed NPU sampling response")); destroy(); }
      }
    });
    output.on("error", fail);
    input.on("error", fail);
    output.on("end", () => fail(new Error("NPU sampling connection closed")));
    output.on("close", () => fail(new Error("NPU sampling connection closed")));
  }
  async request(value: unknown, timeout: number): Promise<Record<string, unknown>> {
    if (this.error && !this.messages.length) throw this.error;
    const next = this.messages.length ? Promise.resolve(this.messages.shift()) : new Promise<unknown>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    const timer = setTimeout(() => { this.pending?.reject(new Error("NPU sampling response timed out")); this.pending = undefined; }, timeout);
    try {
      this.input.write(JSON.stringify({ schemaVersion: 1, ...expectRecord(value, "NPU sampling request") }) + "\n");
      const response = expectRecord(await next, "NPU sampling response");
      if (response.schemaVersion !== 1 || response.type === "error") throw new Error(String(response.message ?? "NPU sampling failed"));
      return response;
    } finally { clearTimeout(timer); }
  }
}

function brokerChannel(): { channel: Channel; token: string } | null {
  const address = process.env.EVALUATOR_HOST_TELEMETRY_ADDRESS;
  if (!address) return null;
  const url = new URL(`tcp://${address}`);
  if (url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname || url.search || url.hash)
    throw new TypeError("Invalid host NPU sampling control address");
  const token = process.env.EVALUATOR_HOST_TELEMETRY_TOKEN;
  if (!token) throw new TypeError("Missing host NPU sampling control token");
  const socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
  return { channel: new Channel(socket, socket, () => socket.destroy()), token };
}

async function hostPython(signal: AbortSignal, configured?: string): Promise<string> {
  for (const marker of ["/.dockerenv", "/run/.containerenv"]) {
    let container = false;
    try { await access(marker); container = true; } catch { /* Absent on a native host. */ }
    if (container) throw new Error("NPU sampling cannot run inside a container; start the toolbox from the NPU host with scripts/toolbox/run.sh");
  }
  const candidates = configured ? [configured] : [...new Set([process.env.PYTHON_BIN, "python3", "python"].filter((value): value is string => Boolean(value)))];
  for (const candidate of candidates) {
    try {
      await execute(candidate, ["-B", "-c", "import sys,shutil; assert sys.version_info >= (3,9); assert shutil.which('npu-smi')"],
        { signal, windowsHide: true, timeout: 5000 });
      return candidate;
    } catch { signal.throwIfAborted(); }
  }
  throw new Error("Host NPU sampling needs existing Python 3.9+ and npu-smi; enter the toolbox with scripts/toolbox/run.sh on the NPU host");
}

function targetsFrom(response: Record<string, unknown>, devices: Device[]): HostNpuTarget[] {
  if (!Array.isArray(response.targets)) throw new TypeError("Missing host NPU targets");
  const seen = new Set<string>();
  const targets = response.targets.map(value => {
    const target = expectRecord(value, "host NPU target");
    const device = devices.find(device => device.deviceId === target.deviceId);
    if (!device || target.chipId !== undefined && (!Number.isSafeInteger(target.chipId) || Number(target.chipId) < 0) ||
        device.chipId !== undefined && target.chipId !== device.chipId ||
        !Array.isArray(target.errors) || target.errors.some(error => typeof error !== "string")) throw new TypeError("Invalid host NPU target");
    const key = `${device.deviceId}/${target.chipId ?? "unknown"}`;
    if (seen.has(key)) throw new TypeError("Duplicate host NPU target");
    seen.add(key);
    if (target.endpoint !== null) {
      if (typeof target.endpoint !== "string") throw new TypeError("Invalid host NPU endpoint");
      const url = new URL(target.endpoint);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/metrics" ||
          url.username || url.password || url.search || url.hash || target.chipId === undefined) throw new TypeError("Invalid host NPU endpoint");
    }
    return { deviceId: device.deviceId, ...(target.chipId === undefined ? {} : { chipId: Number(target.chipId) }),
      endpoint: target.endpoint, errors: target.errors.map(String) };
  });
  if (devices.some(device => !targets.some(target => target.deviceId === device.deviceId))) throw new TypeError("Incomplete host NPU targets");
  return targets;
}

/** doctor probes the control channel or executable availability, never a device. */
export async function checkHostTelemetry(signal: AbortSignal, pythonExecutable?: string): Promise<void> {
  const broker = brokerChannel();
  if (!broker) { await hostPython(signal, pythonExecutable); return; }
  const abort = () => broker.channel.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const response = await broker.channel.request({ op: "ping", token: broker.token }, 5000);
    if (response.type !== "pong") throw new TypeError("Invalid host NPU sampling health response");
  } finally { signal.removeEventListener("abort", abort); broker.channel.destroy(); }
}

export async function startHostTelemetry(devices: Device[], artifacts: string, signal: AbortSignal, pythonExecutable?: string): Promise<HostNpuSampling> {
  let channel: Channel | undefined;
  const unavailable = (message: string) => devices.map(device => ({ ...device, endpoint: null, errors: [message] }));
  let targets: HostNpuTarget[] = [];
  let finish: Promise<HostNpuTarget[]> | undefined;
  const abort = () => channel?.destroy();
  try {
    signal.throwIfAborted();
    const broker = brokerChannel();
    let token: string | undefined;
    if (broker) { channel = broker.channel; token = broker.token; }
    else {
      const python = await hostPython(signal, pythonExecutable);
      const helper = fileURLToPath(new URL("./assets/host_telemetry.py", import.meta.url));
      const child = spawn(python, ["-B", "-u", helper, "--artifacts", artifacts], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      channel = new Channel(child.stdin, child.stdout, () => { child.stdin.destroy(); child.kill("SIGTERM"); });
      child.on("error", () => channel?.destroy());
    }
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    const response = await channel.request({ op: "sample", devices, ...(token ? { token } : {}) }, 30000 + devices.length * 20000);
    if (response.type !== "ready") throw new TypeError("Invalid host NPU sampling startup response");
    targets = targetsFrom(response, devices);
    signal.throwIfAborted();
    signal.removeEventListener("abort", abort);
    const active = channel;
    return { targets, finish: () => finish ??= (async () => {
      try {
        const response = await active.request({ op: "finish" }, 15000);
        if (response.type !== "finished") throw new TypeError("Invalid host NPU sampling shutdown response");
        return targetsFrom(response, devices);
      } catch (error) {
        return targets.map(target => ({ ...target, errors: [...target.errors, error instanceof Error ? error.message : "NPU sampling cleanup failed"] }));
      } finally { signal.removeEventListener("abort", abort); active.destroy(); }
    })() };
  } catch (error) {
    signal.removeEventListener("abort", abort); channel?.destroy();
    signal.throwIfAborted();
    targets = unavailable(error instanceof Error ? error.message : "Host NPU sampling unavailable");
    return { targets, finish: async () => targets };
  }
}
