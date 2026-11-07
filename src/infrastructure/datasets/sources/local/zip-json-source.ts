import { readFile } from "node:fs/promises";
import type { JsonValue, SourceLock } from "../../../../core/contracts/task.js";
import type { DatasetRecordSource } from "../../record-source.js";
import { readZipJson } from "../../input-readers/zip-json.js";
import { LocalFileSource } from "./files-source.js";
import { assertJsonValue } from "../../../../core/validation/input.js";

/** Accept the published ZIP or its extracted directory without downloading it. */
export class LocalZipJsonSource implements DatasetRecordSource {
  private readonly files: LocalFileSource;
  private readonly zipped: boolean;
  constructor(path: string, private readonly selections: Record<string, string>) {
    this.zipped = path.toLowerCase().endsWith(".zip");
    this.files = new LocalFileSource(path, { dataset: "drop", selections: this.zipped
      ? [{ path: "dataset.zip" }] : Object.values(selections).map(path => ({ path })) });
  }
  resolve(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> { return this.files.resolve(previous, signal); }
  async *rows(lock: SourceLock, selection: string, signal: AbortSignal): AsyncIterable<JsonValue> {
    const name = this.selections[selection];
    if (!name) throw new Error(`Unknown local ZIP selection: ${selection}`);
    const path = await this.files.file(lock, this.zipped ? "dataset.zip" : name, signal);
    if (this.zipped) yield await readZipJson(path, name, signal);
    else {
      const value: unknown = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
      assertJsonValue(value);
      yield value;
    }
  }
}
