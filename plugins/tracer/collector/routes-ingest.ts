/** HTTP routes for ingestion, replay and session browsing. */
import { execFile } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { exportAnalysis } from "./analysis-service.js";
import { dirRoots, findDirByName, hasResults } from "./discovery.js";
import { collectDirEntries, importStatic, parseFilesPayload } from "./importer.js";
import { enqueue, materializeAttempt, spoolDir, spoolWrite } from "./ingest.js";
import { type Lang, langOfHeaders, msg } from "./i18n.js";
import * as LLM from "./llm-analysis.js";
import { RT, authorized, type Subscriber } from "./runtime.js";
import { replyJson, unauthorized, type Router } from "./server.js";

type Obj = Record<string, unknown>;

function requestLang(ctx: {
  query(name: string): string | null;
  req: { headers: Record<string, string | string[] | undefined> };
}): Lang {
  return langOfHeaders(ctx.query("lang"), ctx.req.headers["accept-language"]);
}

/** Bounded SSE backlog: a slow browser must not grow collector memory without limit. */
class SseClient implements Subscriber {
  private readonly queue: unknown[] = [];
  private resume: (() => void) | null = null;
  closed = false;

  constructor(private readonly capacity: number) {}

  push(event: unknown): boolean {
    if (this.closed || this.queue.length >= this.capacity) return false;
    this.queue.push(event);
    this.resume?.();
    return true;
  }

  close(): void {
    this.closed = true;
    this.resume?.();
  }

  /** Next event, or null on timeout (used to emit keep-alive pings). */
  async next(timeoutMs: number): Promise<{ event: unknown } | null> {
    if (this.queue.length > 0) return { event: this.queue.shift() };
    if (this.closed) return null;
    return new Promise(resolveNext => {
      let done = false;
      const finish = (value: { event: unknown } | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.resume = null;
        resolveNext(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.resume = () => {
        if (this.queue.length > 0) finish({ event: this.queue.shift() });
        else if (this.closed) finish(null);
      };
    });
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function registerIngestRoutes(router: Router): void {
  router.post("/v1/ingest", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    let raw = await ctx.body();
    if (String(ctx.req.headers["content-encoding"] ?? "").toLowerCase() === "gzip") {
      try {
        raw = gunzipSync(raw);
      } catch {
        return replyJson({ error: "bad gzip" }, 400);
      }
    }
    if (raw.length > RT.cfg.maxBody) return replyJson({ error: "too large" }, 413);
    const lines = raw
      .toString("utf8")
      .split(/\r?\n/)
      .filter(line => line.trim().length > 0);
    if (lines.length === 0) return replyJson({ error: "empty" }, 400);
    let path: string;
    try {
      path = await spoolWrite(ctx.query("session"), lines);
    } catch (error) {
      return replyJson({ error: "spool unavailable", detail: String(error) }, 503);
    }
    RT.st.metrics.received_lines += lines.length;
    if (!enqueue(path)) {
      RT.st.metrics.rejected_429 += 1;
      return replyJson({ error: "backpressure" }, 429, { "retry-after": "1" });
    }
    return replyJson({ accepted: lines.length, queue: RT.st.queue.size }, 202);
  });

  /** Browse directories under results so the browser can pick a run folder. */
  router.get("/v1/dirs", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    const lang = requestLang(ctx);
    const roots = dirRoots();
    if (roots.length === 0) return replyJson({ error: msg(lang, "No results directory found", "没找到 results 目录") }, 400);
    const root = roots[0]!;
    const cur = resolve(root, ctx.query("path", "") ?? "");
    if (cur !== root && !cur.startsWith(root + sep)) {
      return replyJson({ error: msg(lang, "Path escapes the results root", "路径越界") }, 400);
    }
    if (!isDir(cur)) return replyJson({ error: msg(lang, "Directory does not exist", "目录不存在") }, 400);
    const relative = (path: string): string => (path === root ? "" : path.slice(root.length + 1));
    const parent = cur === root ? root : cur.slice(0, cur.lastIndexOf(sep));
    const entries = readdirSync(cur, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(entry => ({
        name: entry.name,
        path: relative(join(cur, entry.name)),
        hasResults: hasResults(join(cur, entry.name)),
      }));
    return replyJson({
      root,
      path: relative(cur),
      parent: cur === root ? null : parent === root ? "" : relative(parent),
      hasResults: hasResults(cur),
      entries,
    });
  });

  /**
   * Import a server-side result directory.
   *
   * `dir` is an absolute path (CLI/debug); `name` is a folder name resolved under the
   * results root, which is all the browser picker exposes.
   */
  router.post("/v1/load-dir", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    const lang = requestLang(ctx);
    const body = await ctx.json<Obj>().catch(() => null);
    if (body === null) return replyJson({ error: "bad json" }, 400);
    const raw = String(body.dir ?? "").trim();
    const name = String(body.name ?? "").trim();
    let root: string | null = null;
    if (raw) {
      const expanded = expandUser(raw);
      if (!expanded.startsWith("/") || !isDir(expanded)) {
        return replyJson(
          { error: msg(lang, `Directory does not exist (an absolute server path is required): ${raw}`, `目录不存在（需要服务器上的绝对路径）：${raw}`) },
          400,
        );
      }
      root = expanded;
    } else if (name) {
      root = findDirByName(name);
      if (root === null) {
        return replyJson(
          { error: msg(lang, `${name} was not found under the server results directory`, `未在服务器 results 目录下找到 ${name}`) },
          400,
        );
      }
    } else {
      return replyJson({ error: msg(lang, "dir or name is required", "需要 dir 或 name") }, 400);
    }
    const result = await importStatic(collectDirEntries(root), String(body.epoch ?? "").trim(), basename(root));
    // Offline imports skip the plugin export hook, so persist results here.
    const epochs = Array.isArray(result.epochs) && result.epochs.length > 0 ? result.epochs : [result.epoch];
    for (const epoch of epochs) {
      if (epoch) exportAnalysis(epoch, root, lang);
    }
    return replyJson({ dir: root, ...result });
  });

  /** Open the desktop folder picker so any directory on this host can be imported. */
  router.post("/v1/pick-dir", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    await ctx.body();
    const lang = requestLang(ctx);
    const path = await pickNativeDir();
    if (path === null) {
      return replyJson({ error: msg(lang, "No directory picker is available in this environment", "当前环境没有可用的目录选择对话框") }, 501);
    }
    if (!path) return replyJson({ cancelled: true });
    const root = expandUser(path);
    if (!isDir(root)) return replyJson({ error: msg(lang, `Selected directory is not accessible: ${path}`, `所选目录不可访问：${path}`) }, 400);
    return replyJson({ dir: root });
  });

  /** Import file contents uploaded by the browser (Windows -> WSL paths are unreadable). */
  router.post("/v1/load-files", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    const lang = requestLang(ctx);
    const raw = await ctx.body();
    if (raw.length > RT.cfg.maxBody) {
      return replyJson({ error: msg(lang, "The directory is too large; pick a single run directory", "目录太大，请选择单个 run 目录") }, 413);
    }
    let body: Obj;
    try {
      body = JSON.parse(raw.toString("utf8") || "{}") as Obj;
    } catch {
      return replyJson({ error: "bad json" }, 400);
    }
    const files = body?.files;
    if (!Array.isArray(files) || files.length === 0) return replyJson({ error: msg(lang, "No files received", "没有收到文件") }, 400);
    const entries = parseFilesPayload(files);
    if (entries.length === 0) {
      return replyJson(
        { error: msg(lang, "No recognizable files (agentx-summary.json / trajectory.jsonl)", "没有可识别的文件（agentx-summary.json / trajectory.jsonl）") },
        400,
      );
    }
    const result = await importStatic(entries, String(body.epoch ?? "").trim(), "static");
    return replyJson(result);
  });

  router.get("/v1/stream", async ctx => {
    const session = ctx.query("session");
    const epoch = ctx.query("epoch");
    ctx.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const client = new SseClient(RT.cfg.subQueue);
    RT.st.subscribers.add(client);
    ctx.req.on("close", () => {
      client.close();
      RT.st.subscribers.delete(client);
    });

    const burst: string[] = [": connected\n\n", `: ${" ".repeat(2048)}\n\n`];
    let count = 0;
    for (const trace of RT.db.replayTraces(session, epoch, RT.cfg.replayMax)) {
      let payload = trace.payload;
      // Old agentx traces lack started_at/ended_at; rebuild them from events when available
      // so the overview shows real timings.
      const body = trace.payload as Obj | null;
      if (
        trace.kind === "trajectory" &&
        body !== null &&
        typeof body === "object" &&
        (body.started_at === null || body.started_at === undefined) &&
        (!Array.isArray(body.steps) || body.steps.length === 0) &&
        trace.session &&
        RT.db.listEvents(String(trace.epoch), String(trace.session)).length > 0
      ) {
        try {
          payload = materializeAttempt(String(trace.epoch), String(trace.session));
        } catch {
          RT.st.metrics.processing_errors += 1;
        }
      }
      burst.push(
        sse("ingest", {
          session: trace.session,
          kind: trace.kind,
          seq: trace.seq,
          epoch: trace.epoch,
          replay: true,
          text: JSON.stringify(payload),
        }),
      );
      count += 1;
    }
    if (count === 0) {
      for (const [sessionId, cached] of RT.st.sessions) {
        if (session && sessionId !== session) continue;
        if (epoch && cached.epoch !== epoch) continue;
        for (const batch of cached.batches.toArray()) {
          if (count >= RT.cfg.replayMax) break;
          burst.push(
            sse("ingest", {
              session: sessionId,
              kind: batch.kind,
              seq: batch.seq,
              epoch: cached.epoch,
              replay: true,
              text: JSON.stringify(batch.data),
            }),
          );
          count += 1;
        }
      }
    }
    // Empty replay: tell the client explicitly instead of showing a blank page.
    if (count === 0) burst.push(sse("replay_empty", { epoch, session }));
    ctx.res.write(burst.join(""));

    void (async () => {
      while (!client.closed) {
        const next = await client.next(5000);
        if (client.closed) break;
        ctx.res.write(next === null ? ": ping\n\n" : sse("ingest", next.event));
      }
      ctx.res.end();
    })();
    return undefined;
  });

  router.get("/v1/sessions", async ctx => {
    const epoch = ctx.query("epoch");
    const rows = RT.db.listSessions(epoch);
    return replyJson({
      sessions: rows.map(row => ({
        id: row.session,
        epoch: row.epoch,
        kind: row.kind,
        count: row.count,
        firstAt: row.first_at,
        updatedAt: row.updated_at,
        stats: row.stats,
      })),
    });
  });

  router.get("/v1/sessions/:sid", async ctx => {
    const sid = ctx.params.sid!;
    const epoch = ctx.query("epoch");
    const limit = ctx.intQuery("limit", 200, 1, 1000);
    const offset = ctx.intQuery("offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const resolvedEpoch = epoch ?? RT.db.latestSessionEpoch(sid);
    const row = resolvedEpoch ? RT.db.getSession(resolvedEpoch, sid) : null;
    if (row !== null) {
      const total = RT.db.countTraces(resolvedEpoch as string, sid);
      const traces = RT.db.listTraces(resolvedEpoch as string, sid, limit, offset);
      return replyJson({
        id: sid,
        epoch: resolvedEpoch,
        kind: row.kind,
        count: row.count,
        firstAt: row.first_at,
        updatedAt: row.updated_at,
        stats: row.stats,
        total,
        limit,
        offset,
        hasMore: offset + traces.length < total,
        batches: traces.map(trace => ({ seq: trace.seq, kind: trace.kind, data: trace.payload })),
      });
    }
    const cached = RT.st.sessions.get(sid);
    if (cached === undefined) return replyJson({ error: "not found" }, 404);
    const all = cached.batches.toArray();
    const batches = all.slice(offset, offset + limit);
    return replyJson({
      id: cached.id,
      epoch: cached.epoch,
      kind: cached.kind,
      count: cached.count,
      firstAt: cached.firstAt,
      updatedAt: cached.updatedAt,
      stats: cached.stats,
      total: all.length,
      limit,
      offset,
      hasMore: offset + batches.length < all.length,
      batches: batches.map(batch => ({ seq: batch.seq, kind: batch.kind, data: batch.data })),
    });
  });

  router.delete("/v1/sessions/:sid", async ctx => {
    if (!authorized(ctx.req)) return unauthorized();
    const sid = ctx.params.sid!;
    RT.st.sessions.delete(sid);
    RT.st.seen.delete(sid);
    RT.db.deleteSession(sid, ctx.query("epoch"));
    return replyJson({ ok: true });
  });

  router.get("/metrics", async () => {
    const m = RT.st.metrics;
    let spoolDepth = -1;
    try {
      spoolDepth = readdirSync(spoolDir()).filter(name => name.endsWith(".ndjson") && name !== "dead-letter.ndjson").length;
    } catch {
      spoolDepth = -1;
    }
    const body = [
      `trace_received_lines_total ${m.received_lines}`,
      `trace_accepted_lines_total ${m.accepted}`,
      `trace_deduped_lines_total ${m.deduped}`,
      `trace_sampled_dropped_total ${m.sampled_drop}`,
      `trace_rejected_429_total ${m.rejected_429}`,
      `trace_bad_lines_total ${m.bad_lines}`,
      `trace_broadcasts_total ${m.broadcasts}`,
      `trace_unknown_kind_lines_total ${m.unknown_kind_lines}`,
      `trace_unknown_format_lines_total ${m.unknown_format_lines}`,
      `trace_processing_errors_total ${m.processing_errors}`,
      `trace_dead_letter_total ${m.dead_letter_lines}`,
      `trace_events_accepted_total ${m.events_accepted}`,
      `trace_outcomes_accepted_total ${m.outcomes_accepted}`,
      `trace_unknown_event_lines_total ${m.unknown_event_lines}`,
      `trace_db_errors_total ${m.db_errors}`,
      `trace_sse_dropped_total ${m.sse_dropped}`,
      `trace_retention_purged_epochs_total ${m.retention_purged_epochs}`,
      `trace_spool_depth ${spoolDepth}`,
      `trace_queue_depth ${RT.st.queue.size}`,
      `trace_sse_clients ${RT.st.subscribers.size}`,
      `trace_sessions ${RT.st.sessions.size}`,
      `trace_llm_calls_total ${LLM.STATS.calls}`,
      `trace_llm_cache_hits_total ${LLM.STATS.cache_hits}`,
      `trace_llm_failures_total ${LLM.STATS.failures}`,
      `trace_llm_dropped_findings_total ${LLM.STATS.dropped}`,
      `trace_llm_translate_calls_total ${LLM.STATS.translate_calls}`,
      `trace_llm_translate_cache_hits_total ${LLM.STATS.translate_cache_hits}`,
      `trace_llm_translate_failures_total ${LLM.STATS.translate_failures}`,
    ].join("\n");
    return { text: `${body}\n`, headers: { "content-type": "text/plain; charset=utf-8" } };
  });

  router.get("/healthz", async () =>
    replyJson({
      ok: true,
      sessions: RT.st.sessions.size,
      clients: RT.st.subscribers.size,
      db: RT.cfg.db,
      spool: RT.cfg.spool,
    }),
  );
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

const PICK_PS = `$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

// The WinForms FolderBrowserDialog falls back to the legacy shell tree; use the
// system folder picker (IFileOpenDialog with FOS_PICKFOLDERS) instead.
public static class TracerFolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW { }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName(out IntPtr pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private const uint FOS_PICKFOLDERS = 0x20;
    private const uint FOS_FORCEFILESYSTEM = 0x40;
    private const uint FOS_PATHMUSTEXIST = 0x800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;

    public static string Pick(string title)
    {
        var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
        uint options;
        dlg.GetOptions(out options);
        dlg.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        dlg.SetTitle(title);
        // Owned by the active window so the dialog comes up in front of the browser.
        if (dlg.Show(GetForegroundWindow()) != 0) return "";
        IShellItem result;
        dlg.GetResult(out result);
        IntPtr name;
        result.GetDisplayName(SIGDN_FILESYSPATH, out name);
        string path = Marshal.PtrToStringUni(name);
        Marshal.FreeCoTaskMem(name);
        return path ?? "";
    }
}
'@
[TracerFolderPicker]::Pick('选择要导入的 run 目录')
`;

/** Return a picked path, "" when cancelled, or null when no dialog exists here. */
async function pickNativeDir(): Promise<string | null> {
  const powershell = which("powershell.exe");
  if (powershell) {
    // WSL interop: the dialog runs on the Windows desktop, so translate its path back.
    return runWindowsPicker(powershell);
  }
  if (which("zenity")) {
    return runPicker("zenity", ["--file-selection", "--directory", "--title=选择要导入的 run 目录"]);
  }
  if (which("kdialog")) return runPicker("kdialog", ["--getexistingdirectory", homedir()]);
  return null;
}

async function runWindowsPicker(powershell: string): Promise<string | null> {
  // -Command would garble the Chinese title; a UTF-8 BOM script file keeps it intact.
  const dir = mkdtempSync(join(tmpdir(), "tracer-pick-"));
  const script = join(dir, "pick.ps1");
  try {
    writeFileSync(script, `\ufeff${PICK_PS}`, "utf8");
    return await runPicker(powershell, [
      "-NoProfile",
      "-STA",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      await toWindowsPath(script),
    ]);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}

async function runPicker(command: string, args: string[]): Promise<string | null> {
  const result = await runCommand(command, args, 600_000);
  if (result === null) return null;
  const lines = result.stdout.trim().split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return "";
  return toLocalPath(lines[lines.length - 1]!.trim());
}

async function toWindowsPath(path: string): Promise<string> {
  const result = await runCommand("wslpath", ["-w", path], 5000);
  return result !== null && result.code === 0 && result.stdout.trim() ? result.stdout.trim() : path;
}

async function toLocalPath(picked: string): Promise<string> {
  const result = await runCommand("wslpath", ["-u", picked], 5000);
  return result !== null && result.code === 0 && result.stdout.trim() ? result.stdout.trim() : picked;
}

function runCommand(command: string, args: string[], timeout: number): Promise<{ code: number; stdout: string } | null> {
  return new Promise(resolveCommand => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (failure && (failure.code === "ENOENT" || failure.killed)) {
        resolveCommand(null);
        return;
      }
      resolveCommand({ code: failure ? 1 : 0, stdout: String(stdout ?? "") });
    });
  });
}

function which(binary: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      const candidate = join(dir, binary);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}
