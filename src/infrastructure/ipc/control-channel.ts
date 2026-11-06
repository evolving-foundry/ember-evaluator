import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 40_000;

function receive(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = "";
    let bytes = 0;
    const decoder = new StringDecoder("utf8");
    const cleanup = () => {
      socket.off("data", data);
      socket.off("error", failed);
      socket.off("end", ended);
      socket.off("close", ended);
      socket.off("timeout", timedOut);
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const ended = () => failed(new Error("Retry control connection closed before a receipt"));
    const timedOut = () => { failed(new Error("Retry control connection timed out")); socket.destroy(); };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES) { failed(new Error("Retry control message is too large")); socket.destroy(); return; }
      text += decoder.write(chunk);
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try { resolve(JSON.parse(text.slice(0, newline))); } catch (error) { reject(error); }
    };
    socket.on("data", data);
    socket.once("error", failed);
    socket.once("end", ended);
    socket.once("close", ended);
    socket.once("timeout", timedOut);
    socket.setTimeout(TIMEOUT_MS);
  });
}

export async function openControlChannel(
  handle: (input: unknown) => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const id = randomUUID();
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\ember-retry-${id}`
    : join(process.env.EVALUATOR_RETRY_SOCKET_DIR ?? tmpdir(), `retry-${id}.sock`);
  // AF_UNIX paths have a small byte limit. Never let the OS silently truncate it.
  if (process.platform !== "win32" && Buffer.byteLength(endpoint) > 103)
    throw new Error("Retry Socket path is too long; choose a shorter EVALUATOR_RETRY_SOCKET_DIR");
  const sockets = new Set<Socket>();
  const processing = new Set<Promise<void>>();
  let stopping = false;
  const server = createServer(socket => {
    sockets.add(socket);
    // Keep a listener after receive() completes to handle disconnects during writes.
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    const work = (async () => {
      try {
        const input = await receive(socket);
        if (stopping) throw new Error("Retry coordinator is closing; resubmit the same request ID after it ends");
        const result = await handle(input);
        socket.end(JSON.stringify({ ok: true, result }) + "\n");
      } catch (error) {
        if (!stopping) onError(error);
        if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : "Retry request failed" }) + "\n");
      }
    })();
    processing.add(work);
    void work.finally(() => processing.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
  });
  server.on("error", onError);
  try {
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
  server.unref();
  return {
    endpoint,
    async close() {
      stopping = true;
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      // Half-open clients must not hold up shutdown. Started handlers finish below.
      for (const socket of sockets) socket.destroy();
      await Promise.all([...processing]);
      await closed;
    },
  };
}

export async function callControlChannel(endpoint: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  const socket = createConnection({ path: endpoint, ...(signal ? { signal } : {}) });
  socket.on("error", () => {});
  try {
    const receipt = receive(socket);
    socket.once("connect", () => socket.write(JSON.stringify(input) + "\n"));
    const response = await receipt;
    if (!response || typeof response !== "object" || !("ok" in response)) throw new Error("Invalid retry control receipt");
    if (response.ok === false) throw new Error("message" in response && typeof response.message === "string" ? response.message : "Retry request failed");
    if (response.ok !== true || !("result" in response)) throw new Error("Invalid retry control receipt");
    return response.result;
  } finally { socket.destroy(); }
}
