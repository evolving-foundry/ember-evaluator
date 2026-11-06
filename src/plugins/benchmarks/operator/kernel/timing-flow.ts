import { expectRecord } from "../../../../core/validation/input.js";
import type { KernelTimingRow } from "./timing.js";

type Event = Record<string, unknown>;
export type RawKernelRow = { device: string; stream: string; name: string; start: string; duration: string; task?: string };

function time(value: unknown): bigint {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,9})?$/u.test(text)) throw new TypeError("Invalid trace timestamp or duration");
  const [integer, fraction = ""] = text.split(".");
  return BigInt(integer!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
}
function one<T>(items: T[], name: string): T {
  if (items.length !== 1) throw new TypeError(`Missing or ambiguous ${name}`);
  return items[0]!;
}
function identity(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new TypeError("Missing or invalid trace identity");
}
function contains(container: Event, event: Event, pid = true): boolean {
  return identity(container.tid) === identity(event.tid) && (!pid || identity(container.pid) === identity(event.pid)) &&
    time(container.ts) <= time(event.ts) && time(event.ts) < time(container.ts) + time(container.dur);
}

/** Match original device rows to CPU steps via causal flows, never by device/CPU clock overlap. */
export function associateKernelSteps(records: RawKernelRow[], trace: string, total: number): KernelTimingRow[] {
  // Node 24 exposes the original numeric token. Nanosecond flow IDs exceed Number precision.
  const parsed: unknown = JSON.parse(trace, (key: string, value: unknown, context?: { source: string }): unknown => {
    if (["id", "correlation_id", "ts", "dur"].includes(key) && typeof value === "number") {
      if (!context) throw new TypeError("Lossless JSON numeric tokens are required");
      return context.source;
    }
    return value;
  });
  const raw = Array.isArray(parsed) ? parsed : expectRecord(parsed, "trace").traceEvents;
  if (!Array.isArray(raw)) throw new TypeError("Invalid trace events");
  const events = raw.map(e => expectRecord(e, "trace event"));
  const steps = events.filter(e => e.ph === "X" && /^ProfilerStep#\d+$/u.test(String(e.name)));
  for (const step of steps) { identity(step.pid); identity(step.tid); }
  const stepId = (e: Event): number => Number(String(e.name).split("#")[1]);
  if (steps.length !== total || new Set(steps.map(stepId)).size !== total || steps.some(s => stepId(s) < 0 || stepId(s) >= total))
    throw new TypeError("Incomplete or duplicate framework steps");
  const source = (end: Event): Event => {
    const id = identity(end.id); identity(end.pid); identity(end.tid);
    const pair = events.filter(e => ["s", "f"].includes(String(e.ph)) && e.name === end.name && e.cat === end.cat && identity(e.id) === id);
    one(pair.filter(e => e.ph === "f"), "flow end");
    return one(pair.filter(e => e.ph === "s"), "flow start");
  };
  const seen = new Set<string>(), kernels = new Set<Event>();
  const rows = records.map(record => {
    const { device, stream, name } = record;
    const start = time(record.start), duration = time(record.duration);
    const key = JSON.stringify([device, stream, name, start.toString(), duration.toString()]);
    if (!device || !stream || !name || seen.has(key)) throw new TypeError("Invalid or duplicate kernel row");
    seen.add(key);
    const kernel = one(events.filter(e => e.ph === "X" && e.name === name && String(e.tid) === stream && time(e.ts) === start && time(e.dur) === duration &&
      (record.task === undefined || String(expectRecord(e.args ?? {}, "kernel args")["Task Id"]) === record.task)), "CSV kernel in trace");
    identity(kernel.pid); identity(kernel.tid);
    kernels.add(kernel);
    const ends = events.filter(e => e.ph === "f" && (e.name === "torch_to_npu" || e.cat === "HostToDevice") &&
      e.pid === kernel.pid && e.tid === kernel.tid && time(e.ts) === start);
    const assigned = new Set<number>();
    for (const end of ends) {
      let cpu = source(end);
      let direct = steps.filter(s => contains(s, cpu, end.name === "torch_to_npu"));
      if (!direct.length && end.cat === "HostToDevice") {
        const dequeue = one(events.filter(e => e.ph === "X" && e.cat === "dequeue" && contains(e, cpu, false)), "host dequeue");
        const queued = one(events.filter(e => e.ph === "f" && e.name === "enqueue_to_dequeue" && e.cat === "async_task_queue" &&
          e.pid === dequeue.pid && e.tid === dequeue.tid && time(e.ts) === time(dequeue.ts)), "queue flow");
        cpu = source(queued);
        direct = steps.filter(s => contains(s, cpu));
      }
      assigned.add(stepId(one(direct, "CPU framework step")));
    }
    return {step:one([...assigned], "kernel flow attribution"),device,stream,name,startUs:Number(record.start),durationUs:Number(record.duration)};
  });
  if (new Set([...kernels].map(k => identity(k.pid))).size !== 1) throw new TypeError("Mixed trace devices");
  const types = new Set(["AI_CORE", "AI_VECTOR_CORE", "AI_CUBE_CORE", "AI_CPU", "MIX_AIC", "MIX_AIV"]);
  const nonKernelTypes = new Set(["MEMCPY_ASYNC", "MEMCPY_SYNC", "MEMSET_ASYNC", "MEMSET_SYNC", "PLACE_HOLDER_SQE"]);
  const targets = events.filter(e => e.ph === "f" && (e.name === "torch_to_npu" || e.cat === "HostToDevice"));
  if (events.some(e => {
    if (e.ph !== "X" || kernels.has(e)) return false;
    const type = String(expectRecord(e.args ?? {}, "kernel args")["Task Type"]);
    return types.has(type) || (!nonKernelTypes.has(type) && targets.some(f => f.pid === e.pid && f.tid === e.tid && time(f.ts) === time(e.ts)));
  })) throw new TypeError("Trace kernel missing from CSV");
  return rows;
}
