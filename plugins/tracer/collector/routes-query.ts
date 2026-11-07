/** HTTP routes for feedback, conclusions, signals and LLM analysis. */
import * as LLM from "./llm-analysis.js";
import { buildFeedback, population } from "./aggregate.js";
import {
  analyzing,
  artifactsOf,
  clearFailed,
  conclusionOf,
  conclusionPayload,
  exportAnalysis,
  failed,
  markAnalyzing,
  markFailed,
  release,
  reanalyze,
  runAnalysisDir,
  signalsMarkdown,
  signalsPayload,
} from "./analysis-service.js";
import { RUNNING_STATUSES } from "./ingest.js";
import { type Lang, langOfHeaders, msg, scopeOf } from "./i18n.js";
import { analyzeEpoch, analyzeTrajectory } from "./llm-analysis.js";
import { RT, authorized } from "./runtime.js";
import { replyJson, unauthorized, type Router } from "./server.js";
import { analyzeDigest, buildSignals, signalsToFindings, type Signal } from "./signals.js";

type Obj = Record<string, unknown>;

const NO_STORE = { "Cache-Control": "no-store" };

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requestLang(ctx: { query(name: string): string | null; req: { headers: Record<string, string | string[] | undefined> } }): Lang {
  return langOfHeaders(ctx.query("lang"), ctx.req.headers["accept-language"]);
}

function storeDisabled(): ReturnType<typeof replyJson> {
  return replyJson({ error: "store disabled" }, 503);
}

export type FeedbackResult = { ok: true; body: Obj } | { ok: false; status: number; error: string };

/** Feedback payload shared by the HTTP route and the single-file snapshot export. */
export function feedbackPayload(epoch: string | null, target: string | null, lang: Lang = "en"): FeedbackResult {
  if (RT.store === null) return { ok: false, status: 503, error: "store disabled" };
  const ep = epoch ?? RT.store.latestEpoch();
  if (!ep) return { ok: false, status: 404, error: "no epoch" };
  const run = RT.store.getRun(ep) ?? {};
  const traces = RT.store.listTraces(ep);
  const outcomes = RT.store.listOutcomes(ep);
  const fb = buildFeedback(ep, run, traces, outcomes, RT.store, lang);
  // target filtering only affects the panel; the verdict uses all signals.
  const allSignals = fb.signals;
  if (target) {
    fb.signals = listOf(fb.signals).filter(signal => asObject(signal).target === target);
  }
  // English is canonical; Chinese is only valid while it was translated from the current English
  // payload, so a stale translation is rebuilt instead of being served or mixed in.
  const configured = LLM.config() !== null;
  const factsHash = configured ? LLM.digestHash(LLM.buildFacts(traces, outcomes)[0]) : null;
  const enAnalysis = RT.store.getLatestAnalysis(ep, scopeOf("epoch", "en")) as Obj | null;
  const zhAnalysis = RT.store.getLatestAnalysis(ep, scopeOf("epoch", "zh")) as Obj | null;
  const enFresh = enAnalysis !== null && (factsHash === null || asObject(enAnalysis).digest_hash === factsHash);
  const zhFresh =
    enFresh && zhAnalysis !== null && asObject(zhAnalysis).translated_from === LLM.contentHash(asObject(enAnalysis));
  const stale = lang === "zh" ? !zhFresh : !enFresh;
  let analysis = lang === "zh" ? (zhFresh ? zhAnalysis : null) : enFresh ? enAnalysis : null;
  // Only finished epochs are analyzed automatically: running ones still change,
  // and imported snapshots may report "unknown" rather than "finished".
  if (
    stale &&
    !RUNNING_STATUSES.has(String(run.status ?? "").toLowerCase()) &&
    configured &&
    !analyzing(ep) &&
    !failed(ep)
  ) {
    markAnalyzing(ep);
    void reanalyze(ep, lang);
  }
  if (analysis === null) {
    analysis = {
      source: "rules",
      model: null,
      digest_hash: null,
      findings: signalsToFindings(fb.signals as Signal[]),
    };
    if (LLM.STATS.last_error) analysis.llm_error = LLM.STATS.last_error;
  }
  fb.analysis = analysis;
  fb.artifacts = artifactsOf(run);
  fb.conclusion = conclusionOf(ep, {
    run,
    traces,
    outcomes,
    population: fb.population as Obj,
    signals: allSignals as Obj[],
    delta: fb.delta_vs_parent as Obj | null,
    analysis,
    lang,
  });
  fb.lang = lang;
  fb.llm = {
    calls: LLM.STATS.calls,
    cache_hits: LLM.STATS.cache_hits,
    failures: LLM.STATS.failures,
    translate_calls: LLM.STATS.translate_calls,
    translate_cache_hits: LLM.STATS.translate_cache_hits,
    translate_failures: LLM.STATS.translate_failures,
    configured,
  };
  RT.store.saveFeedback(ep, fb);
  return { ok: true, body: fb };
}

export function registerQueryRoutes(router: Router): void {
  router.get("/v1/outcomes", async ctx => {
    if (RT.store === null) return storeDisabled();
    const epoch = ctx.query("epoch");
    if (!epoch) return replyJson({ error: "epoch required" }, 400);
    return replyJson(
      {
        epoch,
        outcomes: RT.store.listOutcomes(epoch).map(outcome => ({
          task_id: outcome.task_id,
          success: outcome.success,
          reward: outcome.reward,
        })),
      },
      200,
      NO_STORE,
    );
  });

  router.get("/v1/feedback", async ctx => {
    const result = feedbackPayload(ctx.query("epoch"), ctx.query("target"), requestLang(ctx));
    if (!result.ok) return replyJson({ error: result.error }, result.status, NO_STORE);
    return replyJson(result.body, 200, NO_STORE);
  });

  /** Deterministic verdict plus evidence, attribution and next actions. */
  router.get("/v1/conclusion", async ctx => {
    if (RT.store === null) return storeDisabled();
    const ep = ctx.query("epoch") ?? RT.store.latestEpoch();
    if (!ep) return replyJson({ error: "no epoch" }, 404);
    // Never return an empty conclusion for an explicitly unknown epoch.
    if (RT.store.getRun(ep) === null && RT.store.countTraces(ep) === 0 && RT.store.listOutcomes(ep).length === 0) {
      return replyJson({ error: `unknown epoch: ${ep}` }, 404);
    }
    const format = ctx.query("format", "json");
    const payload = conclusionPayload(ep, format ?? "json", requestLang(ctx));
    if (format === "md") {
      return {
        text: String(payload),
        headers: { "content-type": "text/markdown; charset=utf-8", ...NO_STORE },
      };
    }
    return replyJson(payload, 200, NO_STORE);
  });

  /** Rule signals: json for downstream/RSI, md for humans. */
  router.get("/v1/signals", async ctx => {
    if (RT.store === null) return storeDisabled();
    const ep = ctx.query("epoch") ?? RT.store.latestEpoch();
    if (!ep) return replyJson({ error: "no epoch" }, 404);
    const lang = requestLang(ctx);
    const payload = signalsPayload(ep, lang);
    if (ctx.query("format", "json") === "md") {
      return {
        text: signalsMarkdown(payload, lang),
        headers: { "content-type": "text/markdown; charset=utf-8", ...NO_STORE },
      };
    }
    return replyJson(payload, 200, NO_STORE);
  });

  /** Write deterministic results to each run directory; never triggers an LLM call. */
  router.get("/v1/export-files", async ctx => {
    if (RT.store === null) return storeDisabled();
    const epoch = ctx.query("epoch");
    const all = ctx.intQuery("all", 0, 0, 1);
    const lang = requestLang(ctx);
    let epochs: string[];
    if (epoch) {
      epochs = [epoch];
    } else if (all) {
      epochs = RT.store.listEpochs().map(row => String(row.epoch));
    } else {
      return replyJson({ error: msg(lang, "epoch or all=1 is required", "需要 epoch 或 all=1") }, 400);
    }
    const done: string[] = [];
    const noDir: string[] = [];
    for (const ep of epochs) {
      if (runAnalysisDir(ep) === null) {
        noDir.push(ep);
        continue;
      }
      exportAnalysis(ep, null, lang);
      done.push(ep);
    }
    return replyJson({ exported: done.length, not_found: noDir.length, epochs: done, no_dir: noDir });
  });

  /** Force a fresh LLM analysis, bypassing the cache and the failure blacklist. */
  router.post("/v1/feedback/rerun", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    if (RT.store === null) return storeDisabled();
    await ctx.body();
    const lang = requestLang(ctx);
    const ep = ctx.query("epoch") ?? RT.store.latestEpoch();
    if (!ep) return replyJson({ error: "no epoch" }, 404);
    if (LLM.config() === null) return replyJson({ error: msg(lang, "LLM provider is not configured", "未配置 LLM provider") }, 400);
    const run = RT.store.getRun(ep) ?? {};
    // Imported snapshots may report "unknown"; only skip genuinely running epochs.
    if (RUNNING_STATUSES.has(String(run.status ?? "").toLowerCase())) {
      return replyJson(
        { error: msg(lang, "This epoch has not finished, so it cannot be analyzed", "epoch 尚未结束，无法分析") },
        400,
      );
    }
    if (analyzing(ep)) {
      return replyJson({ error: msg(lang, "This epoch is already being analyzed", "该 epoch 正在分析中") }, 409);
    }
    markAnalyzing(ep);
    clearFailed(ep);
    let result: Obj | null;
    try {
      result = await analyzeEpoch(RT.store, ep, true, lang);
    } catch (error) {
      RT.st.metrics.processing_errors += 1;
      markFailed(ep);
      return replyJson({ error: String(error) }, 500);
    } finally {
      release(ep);
    }
    if (result === null) {
      return replyJson({ error: msg(lang, "No trajectories to analyze", "没有可分析的轨迹") }, 400);
    }
    if (result.error) {
      // Failed runs are blacklisted too, so refreshes do not retry and re-bill.
      markFailed(ep);
      return replyJson({ error: result.error }, 502);
    }
    exportAnalysis(ep, null, lang);
    return replyJson({ ok: true, epoch: ep, source: result.source, model: result.model });
  });

  router.post("/v1/analyze", async ctx => {
    let body: unknown;
    try {
      body = await ctx.json<unknown>();
    } catch {
      return replyJson({ error: "invalid json" }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return replyJson({ error: "object required" }, 400);
    }
    const lang = requestLang(ctx);
    const record = body as Obj;
    let digest: unknown = record.digest;
    if ((digest === null || digest === undefined) && "steps" in record) digest = record;
    if (digest !== null && digest !== undefined) {
      // Panel analysis targets one trajectory: LLM first (cached by digest),
      // falling back to rule-based analysis.
      if (RT.store !== null) {
        let result: Obj | null = null;
        try {
          result = await analyzeTrajectory(
            RT.store,
            digest,
            record.epoch === undefined ? null : String(record.epoch),
            lang,
          );
        } catch {
          result = null;
        }
        if (result && result.source === "llm") return replyJson(result);
        const fallback = analyzeDigest(digest, lang);
        if (result && result.error) fallback.llm_error = result.error;
        return replyJson(fallback);
      }
      return replyJson(analyzeDigest(digest, lang));
    }
    const ep = record.epoch;
    if (!ep) return replyJson({ error: "epoch or digest required" }, 400);
    if (RT.store === null) return storeDisabled();
    const stored = RT.store.getLatestAnalysis(String(ep), scopeOf("epoch", lang)) as Obj | null;
    if (stored) {
      return replyJson({
        epoch: ep,
        summary: stored.summary ?? "",
        scores: null,
        source: stored.source,
        model: stored.model,
        findings: stored.findings ?? [],
      });
    }
    const traces = RT.store.listTraces(String(ep));
    const outcomes = RT.store.listOutcomes(String(ep));
    const sigs = buildSignals(traces, outcomes, population(traces, outcomes), lang);
    const result: Obj = {
      epoch: ep,
      summary: msg(lang, "Rule analysis (no LLM call)", "规则分析（未调用 LLM）"),
      scores: null,
      source: "rules",
      findings: signalsToFindings(sigs),
    };
    if (LLM.STATS.last_error) result.llm_error = LLM.STATS.last_error;
    return replyJson(result);
  });
}
