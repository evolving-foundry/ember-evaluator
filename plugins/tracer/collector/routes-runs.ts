/** HTTP routes for run lifecycle, epoch administration and maintenance. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { analyzeEpochTask } from "./analysis-service.js";
import { purgeRetention, spoolDir } from "./ingest.js";
import { langOfHeaders, msg } from "./i18n.js";
import { pending } from "./llm-analysis.js";
import { RT, authorized } from "./runtime.js";
import { replyJson, unauthorized, type Router } from "./server.js";

type Obj = Record<string, unknown>;

function storeDisabled(): ReturnType<typeof replyJson> {
  return replyJson({ error: "store disabled" }, 503);
}

function manualCandidateId(epoch: string): string {
  return `manual-${epoch.length <= 16 ? epoch : epoch.slice(0, 8)}`;
}

export function registerRunRoutes(router: Router): void {
  router.post("/v1/runs", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    if (RT.store === null) return storeDisabled();
    const body = await ctx.json<Obj>();
    const epoch = body?.epoch;
    if (!epoch) return replyJson({ error: "epoch required" }, 400);
    RT.db.upsertRun(
      String(epoch),
      (body.candidate_id ?? null) as string | null,
      (body.parent_id ?? null) as string | null,
      body.fingerprint ?? null,
      body.config !== null && typeof body.config === "object" && !Array.isArray(body.config)
        ? (body.config as Obj)
        : null,
    );
    return replyJson({ ok: true, epoch });
  });

  /** Manually link a run to a parent epoch (empty parent unlinks). Missing candidate ids are generated. */
  router.post("/v1/runs/:epoch/link", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    if (RT.store === null) return storeDisabled();
    const epoch = ctx.params.epoch!;
    const body = await ctx.json<Obj>().catch(() => ({} as Obj));
    const current = RT.store.getRun(epoch);
    if (!current) return replyJson({ error: `unknown epoch: ${epoch}` }, 404);
    const parentEpoch = body?.parent_epoch;
    if (!parentEpoch) {
      RT.store.setParent(epoch, null);
      return replyJson({ ok: true, epoch, candidate_id: current.candidate_id, parent_id: null });
    }
    if (parentEpoch === epoch) {
      const lang = langOfHeaders(ctx.query("lang"), ctx.req.headers["accept-language"]);
      return replyJson({ error: msg(lang, "A run cannot be its own parent", "不能把自身设为父轮次") }, 400);
    }
    const parent = RT.store.getRun(String(parentEpoch));
    if (!parent) return replyJson({ error: `unknown parent epoch: ${String(parentEpoch)}` }, 404);
    const parentCandidate = (parent.candidate_id as string | null) || manualCandidateId(String(parentEpoch));
    const currentCandidate = (current.candidate_id as string | null) || manualCandidateId(epoch);
    RT.store.upsertRun(String(parentEpoch), parentCandidate);
    RT.store.upsertRun(epoch, currentCandidate, parentCandidate);
    return replyJson({
      ok: true,
      epoch,
      candidate_id: currentCandidate,
      parent_id: parentCandidate,
      parent_epoch: parentEpoch,
    });
  });

  router.post("/v1/runs/:epoch/finish", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    if (RT.store === null) return storeDisabled();
    await ctx.body();
    const epoch = ctx.params.epoch!;
    const run = RT.store.finishRun(epoch);
    // analysis_pending tells callers to keep polling /v1/feedback for LLM results.
    const pendingAnalysis = pending(RT.store, epoch);
    void analyzeEpochTask(epoch);
    return replyJson({
      ok: true,
      epoch,
      status: run === null ? null : run.status,
      finished_at: run === null ? null : run.finished_at,
      analysis_pending: pendingAnalysis,
    });
  });

  /** Record where the evaluator saved its deterministic artifacts. */
  router.post("/v1/runs/:epoch/artifacts", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    if (RT.store === null) return storeDisabled();
    let body: unknown;
    try {
      body = await ctx.json<unknown>();
    } catch {
      return replyJson({ error: "invalid json" }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return replyJson({ error: "invalid json" }, 400);
    }
    const epoch = ctx.params.epoch!;
    if (RT.store.getRun(epoch) === null) return replyJson({ error: `unknown epoch: ${epoch}` }, 404);
    const artifacts: Obj = {};
    for (const [key, value] of Object.entries(body as Obj)) {
      if (typeof value === "string" || typeof value === "number") artifacts[key] = String(value);
    }
    RT.store.setArtifacts(epoch, artifacts);
    return replyJson({ ok: true, epoch });
  });

  router.get("/v1/epochs", async () => {
    if (RT.store === null) return storeDisabled();
    return replyJson({ epochs: RT.store.listEpochs() }, 200, { "Cache-Control": "no-store" });
  });

  router.delete("/v1/epochs/:epoch", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    if (RT.store === null) return storeDisabled();
    const epoch = ctx.params.epoch!;
    RT.store.deleteEpoch(epoch);
    for (const [sid, session] of [...RT.st.sessions]) {
      if (session.epoch === epoch) {
        RT.st.sessions.delete(sid);
        RT.st.seen.delete(sid);
      }
    }
    return replyJson({ ok: true, epoch });
  });

  router.get("/v1/admin/dead-letter", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    const limit = ctx.intQuery("limit", 50, 1, 1000);
    const path = join(spoolDir(), "dead-letter.ndjson");
    const items: unknown[] = [];
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      // Trailing newline yields an empty element; only the last `limit` non-empty lines matter.
      const tail = lines.filter(line => line.length > 0).slice(-limit);
      for (const line of tail) {
        try {
          items.push(JSON.parse(line) as unknown);
        } catch {
          items.push({ line });
        }
      }
    }
    return replyJson({ count: items.length, limit, items });
  });

  router.post("/v1/admin/retention", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    if (RT.store === null) return storeDisabled();
    const raw = ctx.query("days");
    let window = RT.cfg.retentionDays;
    if (raw !== null && raw !== "") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) return replyJson({ error: "invalid days" }, 400);
      window = parsed;
    }
    if (!window || window <= 0) return replyJson({ error: "retention disabled; pass ?days=N" }, 400);
    RT.cfg.retentionDays = window;
    const purged = purgeRetention();
    return replyJson({ ok: true, retention_days: window, purged });
  });

  router.delete("/v1/admin/db", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    if (RT.store === null) return storeDisabled();
    if (ctx.query("confirm", "") !== "yes") return replyJson({ error: "pass ?confirm=yes" }, 400);
    RT.store.purge();
    RT.st.sessions.clear();
    RT.st.seen.clear();
    return replyJson({ ok: true });
  });
}
