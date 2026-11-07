/** HTML rendering: the live dashboard and the offline single-file snapshot. */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { feedbackPayload } from "./routes-query.js";
import { RT } from "./runtime.js";
import { replyJson, type Reply } from "./server.js";

const CSS_SLOT = "<!-- VIEW_CSS -->";
const JS_SLOT = "<!-- VIEW_JS -->";

/** Loaded in order into one script block, so globals stay shared. */
const JS_FILES = ["i18n.js", "core.js", "traj.js", "metrics.js", "feedback.js", "app.js"] as const;

/** Live SSE bootstrap; the escapes are resolved by the browser, not by this module. */
const LIVE_BOOTSTRAP = String.raw`
<script>
(function(){
  if(!window.EventSource) return;
  var qs=new URLSearchParams(location.search);
  var session=qs.get("session")||"";
  var epoch=qs.get("epoch")||"";
  var n=0;
  var es=null;
  var hideT=null;
  var pill=document.createElement("div");
  pill.style.cssText="position:fixed;right:12px;bottom:12px;z-index:99999;padding:4px 10px;border-radius:12px;font:13px/1.6 ui-monospace,Menlo,monospace;background:#21262d;color:#8b949e;border:1px solid #30363d;display:none;transition:opacity .5s";
  var tr=typeof window.T==="function"?window.T:function(s){return s;};
  pill.title=tr("SSE live push: events from a running evaluation are appended without a refresh");
  document.body.appendChild(pill);
  // The badge only appears for live events; replay and history stay silent.
  function showPill(txt,color){pill.textContent=txt;pill.style.color=color;pill.style.display="block";pill.style.opacity="1";clearTimeout(hideT);hideT=setTimeout(function(){pill.style.opacity="0";},8000);}
  function tag(){return epoch||session||tr("all");}
  function handle(e){
    var m;try{m=JSON.parse(e.data);}catch(err){console.warn("[live] bad json",err);return;}
    if(epoch&&m.epoch!==epoch){console.log("[live] skip epoch",m.epoch,"current",epoch);return;}
    if(m.text!=null&&typeof window.ingest==="function"){try{window.ingest(m.text,true);}catch(err){console.warn("[live] ingest failed",err);}}
    if(m.replay)return;
    n++;
    var steps=typeof window.__stepCount==="function"?window.__stepCount():null;
    showPill(tr("\u25cf live \u00b7 ")+tag()+(steps==null?tr(" \u00b7 event #")+n:tr(" \u00b7 steps ")+steps),"#3fb950");
    console.log("[live] event #"+n,m.kind,m.session);
  }
  function connect(){
    if(es){try{es.close();}catch(err){}es=null;}
    n=0;
    // Replay always covers the whole epoch; session only restores the selection,
    // otherwise a refresh would leave a single trajectory in the list.
    var p=[];
    if(epoch)p.push("epoch="+encodeURIComponent(epoch));
    var url="/v1/stream"+(p.length?"?"+p.join("&"):"");
    es=new EventSource(url);
    es.addEventListener("open",function(){console.log("[live] connected",url);});
    es.addEventListener("error",function(){showPill(tr("\u25cb live: reconnecting…"),"#d29922");console.log("[live] reconnecting");});
    es.addEventListener("ingest",handle);
    es.addEventListener("replay_empty",function(){if(typeof window.__emptyEpoch==="function")window.__emptyEpoch(tag());});
    es.onmessage=handle;
  }
  window.__liveConnect=function(ep){epoch=ep||"";connect();};
  window.__clearSession=function(){session="";};
  // Follow the newest epoch unless the user picked one explicitly.
  function pollLatest(){
    if(session)return;
    fetch("/v1/epochs",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
      var latest=d.epochs&&d.epochs[0]&&d.epochs[0].epoch;
      if(!latest||latest===epoch)return;
      if(typeof window.__followLatest!=="function"||!window.__followLatest())return;
      if(typeof window.__setEpoch!=="function")return;
      epoch=latest;window.__setEpoch(latest,true);
    }).catch(function(){});
  }
  setInterval(pollLatest,5000);
  if(epoch){connect();return;}
  // Opened with ?session= only: resolve its epoch before connecting.
  if(session){
    fetch("/v1/sessions",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
      var arr=d.sessions||[];
      for(var i=0;i<arr.length;i++){if(arr[i].id===session&&arr[i].epoch){epoch=arr[i].epoch;break;}}
      if(typeof window.__syncEpoch==="function")window.__syncEpoch(epoch);
      connect();
    }).catch(function(){connect();});
    return;
  }
  fetch("/v1/epochs").then(function(r){return r.json();}).then(function(d){
    epoch=(d.epochs&&d.epochs[0]&&d.epochs[0].epoch)||"";
    if(typeof window.__syncEpoch==="function")window.__syncEpoch(epoch);
    connect();
  }).catch(function(){connect();});
})();
</script>`;

const PAGE_CACHE: { html: string | null; stamp: string | null } = { html: null, stamp: null };

function viewDir(): string {
  const path = RT.cfg.view;
  return isDirectory(path) ? path : dirname(path);
}

function sourceFiles(): string[] {
  const directory = viewDir();
  return ["index.html", "view.css", ...JS_FILES].map(name => join(directory, name));
}

function sourceStamp(paths: string[]): string {
  return paths.map(path => String(statSync(path).mtimeMs)).join("|");
}

function compose(snapshotScript = ""): string {
  const directory = viewDir();
  const read = (name: string): string => readFileSync(join(directory, name), "utf8");
  // Function replacements keep "$" sequences in the payload literal.
  const html = read("index.html")
    .replace(CSS_SLOT, () => `<style>\n${read("view.css")}\n</style>`)
    .replace(JS_SLOT, () => `${snapshotScript}<script>\n${JS_FILES.map(read).join("\n")}\n</script>`);
  return html;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Recomposes the dashboard only when one of its source files changed. */
export function renderLivePage(): string {
  const stamp = sourceStamp(sourceFiles());
  if (PAGE_CACHE.html === null || PAGE_CACHE.stamp !== stamp) {
    const html = compose();
    PAGE_CACHE.html = html.includes("</body>")
      ? html.replace("</body>", () => `${LIVE_BOOTSTRAP}\n</body>`)
      : html + LIVE_BOOTSTRAP;
    PAGE_CACHE.stamp = stamp;
  }
  return PAGE_CACHE.html;
}

/** Inlines the snapshot payload; "</" is escaped so data cannot close the script block early. */
export function renderSnapshot(snapshot: unknown): string {
  const payload = JSON.stringify(snapshot).replaceAll("</", "<\\/");
  return compose(`<script>window.__SNAPSHOT__=${payload};</script>\n`);
}

export function index(): Reply {
  return {
    text: renderLivePage(),
    headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
  };
}

/** Single-file HTML snapshot with feedback and trace payloads inlined. */
export function exportSnapshot(epoch: string, traces: boolean, lang: "en" | "zh" = "en"): Reply {
  if (RT.store === null) return replyJson({ error: "store disabled" }, 503);
  const result = feedbackPayload(epoch, null, lang);
  if (!result.ok) return replyJson({ error: result.error }, result.status);
  const feedback = result.body;
  const conclusion = asObject(feedback.conclusion);
  const snapshot: Record<string, unknown> = {
    epoch: feedback.epoch ?? epoch,
    exported_at: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    schema_version: conclusion.schema_version,
    rules_version: asObject(conclusion.engine).rules_version,
    feedback,
  };
  if (traces) snapshot.docs = RT.db.listTraces(String(snapshot.epoch)).map(row => row.payload);
  const short = String(snapshot.epoch).slice(0, 8);
  return {
    text: renderSnapshot(snapshot),
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="tracer-${short}-snapshot.html"`,
    },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
