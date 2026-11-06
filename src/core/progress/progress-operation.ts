import type { ActivityListener } from "../contracts/activity.js";
import type { ProgressEvent, ProgressListener } from "./progress.js";
import { LiveOperation } from "./live-progress.js";

/** Keep a stage's timer stable while component observations update its preview. */
export async function progressOperation<T>(
  listener: ProgressListener | undefined,
  event: Pick<ProgressEvent, "phase" | "message" | "taskId" | "attemptId">,
  signal: AbortSignal,
  work: (activity: ActivityListener) => Promise<T>,
): Promise<T> {
  listener?.(event);
  const operation = new LiveOperation(listener, event);
  try {
    const result = await work(operation.activity);
    operation.finish();
    return result;
  } catch (error) {
    operation.finish(signal.aborted ? "cancelled" : "failed");
    throw error;
  }
}
