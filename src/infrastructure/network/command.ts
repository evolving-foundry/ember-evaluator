import { startLocalProcess } from "../process/local.js";

/** Use the common process owner so cancellation also retires descendants on Windows and POSIX. */
export async function networkCommand(executable: string, args: readonly string[], options: {
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  maxBuffer?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = await startLocalProcess({ executable, args: [...args], cwd: options.cwd ?? process.cwd(),
    env: Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    inheritEnv: false, input: null }, options.signal);
  const limit = options.maxBuffer ?? 8 * 1024 * 1024;
  const collect = async (stream: AsyncIterable<Uint8Array>, bounded: boolean) => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) { await child.stop(500); throw new Error("Network command output exceeds limit"); }
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return bounded ? text.slice(-64 * 1024) : text;
  };
  try {
    const [stdout, stderr, result] = await Promise.all([collect(child.stdout, false), collect(child.stderr, true), child.done]);
    options.signal.throwIfAborted();
    return { stdout, stderr, exitCode: result.code ?? -1 };
  } finally { await child.stop(500); }
}
