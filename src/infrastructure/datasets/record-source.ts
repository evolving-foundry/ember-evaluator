import type { JsonValue, SourceLock } from "../../core/contracts/task.js";

/** Download adapters expose locked records without owning task conversion or scoring. */
export interface DatasetRecordSource {
  resolve(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock>;
  rows(lock: SourceLock, selection: string, signal: AbortSignal): AsyncIterable<JsonValue>;
}
