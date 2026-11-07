import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExitResult, ProcessHandle } from "../contracts/environment.js";
import { redactDiagnostic } from "../errors/diagnostics.js";

const LOG_LIMIT_BYTES = 1024 * 1024;

/** Keep bounded, private hook diagnostics while draining verbose commands fully. */
export async function readCollectOutput(
  handle: ProcessHandle, directory: string, signal: AbortSignal, secrets: readonly string[] = [],
): Promise<ExitResult & { stdout: string; stderr: string }> {
  try { await mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch (error) { await handle.stop(100); throw error; }
  const read = async (stream: AsyncIterable<Uint8Array>, name: string) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    let text = "";
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const remaining = LOG_LIMIT_BYTES - bytes;
        if (chunk.byteLength > remaining) truncated = true;
        if (remaining > 0) {
          const saved = chunk.slice(0, remaining);
          chunks.push(saved); bytes += saved.byteLength;
        }
      }
    } finally {
      text = Buffer.concat(chunks).toString("utf8");
      // Do not publish a partial credential or UTF-8 sequence at the cut edge.
      if (truncated) text = text.slice(0, text.lastIndexOf("\n") + 1);
      text = redactDiagnostic(text, secrets) + (truncated ? "\n[output truncated]\n" : "");
      await writeFile(join(directory, name), text, { mode: 0o600 });
    }
    return text;
  };
  const stdout = read(handle.stdout, "stdout.log");
  const stderr = read(handle.stderr, "stderr.log");
  try {
    const [exit, output, diagnostic] = await Promise.all([handle.done, stdout, stderr]);
    signal.throwIfAborted();
    return { ...exit, stdout: output, stderr: diagnostic };
  } finally {
    try { await handle.stop(100); }
    finally { await Promise.allSettled([stdout, stderr]); }
  }
}
