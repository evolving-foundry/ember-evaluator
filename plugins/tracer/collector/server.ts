/** Minimal HTTP router on top of node:http (the collector ships without runtime deps). */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Cached raw request body. */
  body(): Promise<Buffer>;
  /** Parsed JSON body; throws BadRequest on malformed input. */
  json<T = Record<string, unknown>>(): Promise<T>;
  query(name: string, fallback?: string | null): string | null;
  intQuery(name: string, fallback: number, min: number, max: number): number;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}

export class BadRequest extends Error {}

export function replyJson(data: unknown, status = 200, headers: Record<string, string> = {}): Reply {
  return { status, json: data, headers };
}

type Handler = (ctx: Ctx) => Promise<Reply | undefined>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
  }

  get(pattern: string, handler: Handler): void {
    this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler);
  }

  delete(pattern: string, handler: Handler): void {
    this.add("DELETE", pattern, handler);
  }

  private match(method: string, path: string): [Handler, Record<string, string>] | null {
    const parts = path.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < parts.length; i += 1) {
        const segment = route.segments[i]!;
        const part = parts[i]!;
        if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(part);
        else if (segment !== part) {
          matched = false;
          break;
        }
      }
      if (matched) return [route.handler, params];
    }
    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const found = this.match(req.method ?? "GET", url.pathname);
    if (found === null) {
      send(res, replyJson({ error: "not found" }, 404));
      return;
    }
    let cachedBody: Promise<Buffer> | null = null;
    const readBody = (): Promise<Buffer> => {
      if (cachedBody === null) {
        cachedBody = new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on("data", chunk => chunks.push(chunk as Buffer));
          req.on("end", () => resolve(Buffer.concat(chunks)));
          req.on("error", reject);
        });
      }
      return cachedBody;
    };
    const ctx: Ctx = {
      req,
      res,
      url,
      params: found[1],
      body: readBody,
      json: async <T>() => {
        const raw = (await readBody()).toString("utf8") || "{}";
        try {
          return JSON.parse(raw) as T;
        } catch {
          throw new BadRequest("bad json");
        }
      },
      query: (name, fallback = null) => url.searchParams.get(name) ?? fallback,
      intQuery: (name, fallback, min, max) => {
        const raw = url.searchParams.get(name);
        if (raw === null || raw.trim() === "") return fallback;
        const value = Number.parseInt(raw, 10);
        if (Number.isNaN(value) || value < min || value > max) throw new BadRequest(`invalid ${name}`);
        return value;
      },
    };
    try {
      const reply = await found[0](ctx);
      if (reply !== undefined) send(res, reply);
    } catch (error) {
      if (error instanceof BadRequest) {
        send(res, replyJson({ error: error.message }, 400));
        return;
      }
      console.error(`[tracer] request failed ${req.method} ${url.pathname}: ${String(error)}`);
      if (!res.headersSent) send(res, replyJson({ error: "internal error" }, 500));
    }
  }
}

function send(res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  let payload: Buffer;
  if (reply.json !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json; charset=utf-8";
    payload = Buffer.from(JSON.stringify(reply.json), "utf8");
  } else {
    headers["content-type"] = headers["content-type"] ?? "text/plain; charset=utf-8";
    payload = Buffer.from(reply.text ?? "", "utf8");
  }
  if (!res.headersSent) {
    headers["content-length"] = String(payload.length);
    res.writeHead(reply.status ?? 200, headers);
  }
  res.end(payload);
}

export function unauthorized(): Reply {
  return replyJson({ error: "unauthorized" }, 401);
}
