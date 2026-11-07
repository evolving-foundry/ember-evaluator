import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DirectoryReceiver } from "./receiver.js";
import { TransferError } from "./protocol.js";

export type ReceiverServerOptions = {
  receiver?: DirectoryReceiver;
  token: string;
  key: string | Buffer;
  cert: string | Buffer;
  host?: string;
  port?: number;
  control?: (route: "runtime" | "control" | "progress", body: unknown) => Promise<unknown>;
};
function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
export function validateTransferToken(token: string): void {
  if (typeof token !== "string" || token.length < 32 || token.length > 4096 || /[\r\n]/u.test(token))
    throw new TransferError("TRANSFER_AUTH_FAILED", "Transfer token must contain 32–4096 characters without newlines");
}
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Manifest body exceeds 2 MiB", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Invalid JSON body");
  }
}
function send(response: ServerResponse, status: number, value: unknown) {
  if (!response.destroyed) {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  }
}
export async function startTransferReceiver(
  options: ReceiverServerOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  validateTransferToken(options.token);
  const expected = tokenDigest(`Bearer ${options.token}`);
  const server = createServer(
    { key: options.key, cert: options.cert, minVersion: "TLSv1.2", requestTimeout: 300_000, headersTimeout: 30_000 },
    (request, response) => {
      void (async () => {
        if (!timingSafeEqual(expected, tokenDigest(request.headers.authorization ?? ""))) {
          request.resume();
          throw new TransferError("TRANSFER_AUTH_FAILED", "Transfer authentication failed", 401);
        }
        const url = new URL(request.url ?? "/", "https://receiver.invalid");
        if (request.method === "POST" && options.control && ["/v1/runtime", "/v1/control", "/v1/progress"].includes(url.pathname))
          return send(
            response,
            200,
            await options.control(url.pathname === "/v1/runtime" ? "runtime" : url.pathname === "/v1/progress" ? "progress" : "control", await jsonBody(request)),
          );
        if (options.receiver && request.method === "POST" && url.pathname === "/v1/begin")
          return send(response, 200, await options.receiver.beginUpload(await jsonBody(request)));
        const file = /^\/v1\/file\/([^/]+)$/u.exec(url.pathname);
        if (options.receiver && request.method === "PUT" && file) {
          await options.receiver.uploadFile(decodeURIComponent(file[1]!), url.searchParams.get("path") ?? "", request);
          return send(response, 200, { uploaded: true });
        }
        const commit = /^\/v1\/commit\/([^/]+)$/u.exec(url.pathname);
        if (options.receiver && request.method === "POST" && commit) {
          request.resume();
          return send(response, 200, await options.receiver.commitUpload(decodeURIComponent(commit[1]!)));
        }
        request.resume();
        throw new TransferError("TRANSFER_NOT_FOUND", "Unknown transfer route", 404);
      })().catch(error => {
        request.resume();
        const known = error instanceof TransferError;
        send(response, known ? error.status : 500, {
          code: known ? error.code : "TRANSFER_FAILED",
          message: known ? error.message : "Receiver could not persist or accept upload",
        });
      });
    },
  );
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `https://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    async close() {
      server.closeIdleConnections();
      await new Promise<void>((done, fail) => {
        server.close(error => (error ? fail(error) : done()));
        server.closeAllConnections();
      });
    },
  };
}
