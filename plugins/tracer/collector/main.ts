/** Trace Collector entry point: configuration, lifecycle and HTTP server. */
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { consumer, purgeRetention, retentionSweeper, spoolDir, spoolSweeper } from "./ingest.js";
import { langOfHeaders } from "./i18n.js";
import { registerIngestRoutes } from "./routes-ingest.js";
import { registerQueryRoutes } from "./routes-query.js";
import { registerRunRoutes } from "./routes-runs.js";
import type { Cfg } from "./runtime.js";
import { RT, State } from "./runtime.js";
import { BadRequest, Router } from "./server.js";
import { TraceStore } from "./trace-store.js";
import { exportSnapshot, index } from "./views.js";

type Setter = (cfg: Cfg, value: string) => void;

const FLAGS: Record<string, Setter> = {
  host: (cfg, value) => { cfg.host = value; },
  port: (cfg, value) => { cfg.port = integer("--port", value); },
  view: (cfg, value) => { cfg.view = value; },
  token: (cfg, value) => { cfg.token = value; },
  "max-queue": (cfg, value) => { cfg.maxQueue = integer("--max-queue", value); },
  "max-body-mb": (cfg, value) => { cfg.maxBody = integer("--max-body-mb", value) * 1024 * 1024; },
  workers: (cfg, value) => { cfg.workers = integer("--workers", value); },
  "sample-rate": (cfg, value) => { cfg.sampleRate = decimal("--sample-rate", value); },
  "max-batches": (cfg, value) => { cfg.maxBatches = integer("--max-batches", value); },
  "max-seen": (cfg, value) => { cfg.maxSeen = integer("--max-seen", value); },
  "sub-queue": (cfg, value) => { cfg.subQueue = integer("--sub-queue", value); },
  db: (cfg, value) => { cfg.db = value; },
  spool: (cfg, value) => { cfg.spool = value; },
  "shutdown-timeout": (cfg, value) => { cfg.shutdownTimeout = decimal("--shutdown-timeout", value); },
  "replay-max": (cfg, value) => { cfg.replayMax = integer("--replay-max", value); },
  "retention-days": (cfg, value) => { cfg.retentionDays = decimal("--retention-days", value); },
  "retention-interval": (cfg, value) => { cfg.retentionInterval = decimal("--retention-interval", value); },
};

function defaultCfg(): Cfg {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = process.cwd();
  const data = join(root, ".cache", "tracer");
  return {
    host: "0.0.0.0",
    port: 8787,
    view: join(here, "view", "index.html"),
    token: "",
    maxQueue: 2000,
    maxBody: 64 * 1024 * 1024,
    workers: 2,
    sampleRate: 1,
    maxBatches: 500,
    maxSeen: 100000,
    subQueue: 2000,
    db: join(data, "trace.db"),
    spool: join(data, "spool"),
    shutdownTimeout: 5,
    replayMax: 2000,
    retentionDays: 0,
    retentionInterval: 3600,
  };
}

function integer(option: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${option} expects a non-negative integer`);
  return parsed;
}

function decimal(option: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${option} expects a non-negative number`);
  return parsed;
}

function parseArgs(argv: string[]): Cfg {
  const cfg = defaultCfg();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) throw new Error(`unexpected argument ${argument}`);
    const body = argument.slice(2);
    const separator = body.indexOf("=");
    const name = separator === -1 ? body : body.slice(0, separator);
    const setter = FLAGS[name];
    if (setter === undefined) throw new Error(`unknown option --${name}`);
    const value = separator === -1 ? argv[++index] : body.slice(separator + 1);
    if (value === undefined) throw new Error(`missing value for --${name}`);
    setter(cfg, value);
  }
  return cfg;
}

function usage(): string {
  const cfg = defaultCfg();
  return [
    "Trace Collector: ingest, materialize and serve evaluation trajectories.",
    "",
    "Options:",
    `  --host <addr>                (default ${cfg.host})`,
    `  --port <port>                (default ${cfg.port})`,
    `  --view <index.html>          (default ${cfg.view})`,
    "  --token <bearer>             protect write APIs (prefer TRACER_TOKEN env)",
    `  --max-queue <n>              (default ${cfg.maxQueue})`,
    `  --max-body-mb <n>            (default ${cfg.maxBody / 1024 / 1024})`,
    `  --workers <n>                (default ${cfg.workers})`,
    `  --sample-rate <0..1>         (default ${cfg.sampleRate})`,
    `  --max-batches <n>            (default ${cfg.maxBatches})`,
    `  --max-seen <n>               (default ${cfg.maxSeen})`,
    `  --sub-queue <n>              (default ${cfg.subQueue})`,
    `  --db <path|:memory:>         (default ${cfg.db})`,
    `  --spool <dir>                (default ${cfg.spool})`,
    `  --shutdown-timeout <seconds> (default ${cfg.shutdownTimeout})`,
    `  --replay-max <n>             (default ${cfg.replayMax})`,
    `  --retention-days <n>         drop epochs idle longer than N days; 0 disables (default ${cfg.retentionDays})`,
    `  --retention-interval <s>     (default ${cfg.retentionInterval})`,
  ].join("\n");
}

function buildRouter(): Router {
  const router = new Router();
  registerIngestRoutes(router);
  registerRunRoutes(router);
  registerQueryRoutes(router);
  router.get("/", async () => index());
  router.get("/v1/export", async ctx => {
    const epoch = ctx.query("epoch");
    if (epoch === null || epoch === "") throw new BadRequest("epoch required");
    return exportSnapshot(epoch, ctx.intQuery("traces", 1, 0, 1) === 1, langOfHeaders(ctx.query("lang"), ctx.req.headers["accept-language"]));
  });
  return router;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function listen(server: Server, cfg: Cfg): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Drains the queue, stops background loops and closes the database. */
async function shutdown(server: Server, background: Promise<void>[]): Promise<void> {
  RT.st.stopping = true;
  for (const subscriber of [...RT.st.subscribers]) subscriber.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));

  const deadline = Date.now() + RT.cfg.shutdownTimeout * 1000;
  while (RT.st.queue.size > 0 && Date.now() < deadline) await delay(25);
  RT.st.queue.close();
  await Promise.allSettled(background);
  RT.store?.close();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const cfg = parseArgs(argv);
  // Managed starts pass the bearer token through the environment; --token stays for manual runs.
  if (cfg.token === "") cfg.token = process.env.TRACER_TOKEN ?? "";
  RT.start(cfg, new State(cfg), cfg.db === "" ? null : new TraceStore(cfg.db));
  spoolDir();

  const background = [spoolSweeper()];
  if (cfg.retentionDays > 0) {
    purgeRetention();
    background.push(retentionSweeper());
  }
  const workers = Array.from({ length: cfg.workers }, () => consumer());

  const router = buildRouter();
  const server = createServer((request, response) => {
    void router.handle(request, response);
  });
  await listen(server, cfg);
  console.log(`[tracer] collector listening on http://${cfg.host}:${cfg.port}`);

  await new Promise<void>(resolve => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await shutdown(server, [...background, ...workers]);
}

main().catch(error => {
  console.error(`[tracer] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
