import { createReadStream } from "node:fs";
import { cp, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { AttemptRecord, AttemptStepResult, SolveResult, Usage } from "../contracts/result.js";
import { collectAttemptAccounting } from "../results/attempt-accounting.js";
import { readTrajectoryPrefix } from "./trajectory-recovery.js";
import { trajectoryType } from "../results/record-validation.js";

const directories = ["agent", "verifier", "logs", "artifacts", "collect"];

export async function archiveStep(root: string, record: AttemptRecord, step: AttemptStepResult): Promise<void> {
  const target = join(root, step.evidencePath);
  await mkdir(target, { recursive: true });
  const present = new Set(await readdir(root));
  for (const name of directories) if (present.has(name)) await cp(join(root, name), join(target, name), { recursive: true, dereference: false });
  const accounting: Pick<AttemptRecord, "key" | "solve" | "accounting"> = { key: record.key, solve: step.solve };
  await collectAttemptAccounting(target, accounting);
  if (accounting.accounting) step.accounting = accounting.accounting;
  await writeFile(join(target, "result.json"), JSON.stringify(step, null, 2) + "\n");
}

export async function clearStepOutputs(root: string): Promise<void> {
  const present = new Set(await readdir(root));
  for (const name of directories) if (present.has(name)) {
    // Keep bind-mounted directory inodes; only remove their contents.
    for (const child of await readdir(join(root, name))) await rm(join(root, name, child), { recursive: true, force: true });
  }
}

export function sumStepSolves(steps: AttemptStepResult[]): SolveResult | null {
  const solved = steps.flatMap(step => step.solve ? [step.solve] : []);
  if (!solved.length) return null;
  const usage: Usage = { inputTokens: null, outputTokens: null, totalTokens: null };
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const known = solved.flatMap(solve => solve.usage[key] === null ? [] : [solve.usage[key]]);
    usage[key] = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  }
  const incomplete = steps.some(step => !step.solve || step.accounting?.complete === false);
  return { finalText: solved.at(-1)!.finalText, usage, ...(incomplete ? { observations: { incomplete: true } } : {}) };
}

/** Preserve raw per-step evidence and expose one valid trajectory to offline consumers. */
export async function combineStepTrajectories(root: string, record: AttemptRecord): Promise<boolean> {
  const steps = record.steps ?? [];
  await mkdir(join(root, "agent"), { recursive: true });
  const output = await open(join(root, "agent/trajectory.jsonl"), "w", 0o600);
  let sequence = 0;
  const append = async (type: string, data: unknown, at = new Date().toISOString()) => {
    await output.write(JSON.stringify({ schemaVersion: 1, seq: ++sequence, at, key: record.key, type, data }) + "\n");
  };
  let complete = true;
  try {
    await append("start", { steps: steps.map(step => step.name) }, record.startedAt);
    for (const step of steps) {
      const stepRoot = join(root, step.evidencePath);
      if ((await readTrajectoryPrefix(stepRoot, record.key)).state !== "complete") complete = false;
      const input = createReadStream(join(stepRoot, "agent/trajectory.jsonl"), { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let ordinal = 0;
      await append("step-start", { name: step.name }, step.startedAt);
      try {
        for await (const line of lines) {
          const event: unknown = JSON.parse(line);
          const type = trajectoryType(event, record.key, ++ordinal);
          if (type === "start" || type === "end" || type === "usage") continue;
          const parsed = event as { data: unknown; at: string };
          await append(type, parsed.data, parsed.at);
        }
      } catch { complete = false; }
      finally { lines.close(); input.destroy(); }
      await append("step-end", { name: step.name }, step.finishedAt);
    }
    const usage: Usage = { inputTokens: null, outputTokens: null, totalTokens: null };
    let cost: number | null = null;
    for (const step of steps) {
      for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
        const value = step.accounting?.usage[key];
        if (value !== null && value !== undefined) usage[key] = (usage[key] ?? 0) + value;
      }
      const value = step.accounting?.cost;
      if (value !== null && value !== undefined) cost = (cost ?? 0) + value;
    }
    await append("usage", { ...usage, cost });
    if (complete) await append("end", { steps: steps.length });
  } finally { await output.close(); }
  // This is an index, not a synthetic native Pi session. Original sessions stay per step.
  if (complete) await writeFile(join(root, "agent/session.jsonl"), JSON.stringify({ type: "step-session-index",
    sessions: steps.map(step => `${step.evidencePath}/agent/session.jsonl`) }) + "\n");
  return complete;
}
