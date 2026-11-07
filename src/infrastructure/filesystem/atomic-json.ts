import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function atomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await fileRetry(() => rename(temporary, path));
  } finally { await fileRetry(() => rm(temporary, { force: true })); }
}
export async function fileRetry<T>(operation: () => Promise<T>): Promise<T> {
  const backoff = [20, 40, 80, 160, 320, 500];
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const wait = backoff[attempt];
      if (wait === undefined || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await delay(wait);
    }
  }
}
