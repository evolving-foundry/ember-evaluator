import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AttemptKey } from "../contracts/result.js";
import type { JsonValue } from "../contracts/task.js";
import { checkedPath } from "./artifacts.js";
import { trajectoryType } from "../results/record-validation.js";

export type TrajectoryPrefix = {
  state: "complete" | "partial" | "missing";
  validRecords: number;
  lastEvent: JsonValue | null;
};

/** Read only the valid prefix, retaining at most one event; never repair the source file. */
export async function readTrajectoryPrefix(root: string, key: AttemptKey): Promise<TrajectoryPrefix> {
  const result: TrajectoryPrefix = { state: "partial", validRecords: 0, lastEvent: null };
  let stream: ReturnType<typeof createReadStream> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    const path = await checkedPath(root, "agent/trajectory.jsonl");
    stream = createReadStream(path, { encoding: "utf8" });
    let terminated = false;
    stream.on("data", chunk => {
      terminated = chunk.toString().endsWith("\n");
    });
    lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lastType = "";
    for await (const line of lines) {
      if (lastType === "end") return result;
      const parsed: unknown = JSON.parse(line);
      lastType = trajectoryType(parsed, key, result.validRecords + 1);
      result.validRecords++;
      result.lastEvent = parsed as JsonValue;
    }
    if (result.validRecords > 1 && lastType === "end" && terminated) result.state = "complete";
  } catch (error) {
    if (!result.validRecords && (error as NodeJS.ErrnoException).code === "ENOENT") result.state = "missing";
  } finally {
    lines?.close();
    stream?.destroy();
  }
  return result;
}
