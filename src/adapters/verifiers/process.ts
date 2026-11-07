import type { ProcessHandle } from "../../core/contracts/environment.js";

export async function readProcess(handle: ProcessHandle, signal: AbortSignal, limit: number | null = 1024 * 1024, cleanupGraceMs = 100): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
  const read = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (limit !== null && bytes > limit) throw new Error("Verifier protocol output exceeds limit");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [exit, stdout, stderr] = await Promise.all([handle.done, read(handle.stdout), read(handle.stderr)]);
    signal.throwIfAborted();
    return { ...exit, stdout, stderr };
  } finally { await handle.stop(cleanupGraceMs); }
}
