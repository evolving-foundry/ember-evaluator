let METRICS=null,METRICS_RAW=null,TAB="traj";
// Without a #tab in the URL, pick the tab from the data type; stop auto-switching once the user clicks a tab
let AUTO_TAB=false;
// One epoch may carry several summaries (agentx standard c1/c4/c8), keyed by concurrency level;
// repeated pushes for the same level (SSE replay + live) overwrite instead of append
let SUMMARIES=new Map();
// Concurrency level -> attempt that produced this summary; the multi-level page must not show only the last one
const SUM_META=new Map();
let ATTEMPT={key:null,trajKey:null,sumKey:null,warn:null};
const TRACES=[];let ACTIVE=-1,TRACEID=0;
const PAL=["#58a6ff","#3fb950","#d29922","#db61a2","#a371f7","#f85149","#39c5cf"];
const fv=v=>v==null?"—":(Math.abs(v)>=100?Math.round(v):Math.abs(v)>=1?+v.toFixed(1):+v.toFixed(3));
// Warmup spans last seconds, not milliseconds; show them in seconds to avoid four-digit ms values
const secFmt=v=>v==null?"—":(Math.abs(v)>=1000?(v/1000).toFixed(2)+"s":Math.round(v)+"ms");
// Lifecycle timestamps render in the UI language; the backend already converted event "at" to epoch seconds
const dtText=v=>{const n=Number(v);if(v==null||!isFinite(n))return "—";const d=new Date(n>1e12?n:n*1000);return isNaN(d.getTime())?"—":d.toLocaleString(getLang()==="zh"?"zh-CN":"en-US",{hour12:false});};
const durText=s=>s==null||!isFinite(s)?"—":(s>=3600?(s/3600).toFixed(1)+" h":s>=60?(s/60).toFixed(1)+" min":Math.round(s)+" s");
// Metric-trust labels: known statuses and sampling errors are localized; unknown errors pass through untouched
const STATUS_LABEL={complete:"complete",partial:"partial",unavailable:"unavailable"};
const statusCN=v=>v==null?tr("unlabeled"):tr(STATUS_LABEL[String(v)]||String(v));
const statusCls=v=>!v?"":v==="complete"?"ok":v==="unavailable"?"bad":"warn";
const REASON_LABEL={full_trace_replay:"Full trace replay",smoke_run:"Smoke run",upstream_submission_not_valid:"Invalid upstream submission",missing_profiling_window:"Missing profiling window",no_successful_requests:"No successful requests"};
const reasonCN=r=>tr(REASON_LABEL[String(r)]||String(r));
// Harness collection errors are a single all-endpoints total; show them once rather than per source
function errCN(e){
  const s=String(e||"");
  const h=s.match(/^Harness recorded (\d+) collection errors; endpoint attribution unavailable, completeness not confirmed$/i);
  if(h)return{global:true,n:+h[1],text:tr("Harness recorded {n} collection errors; endpoint attribution unavailable, completeness not confirmed",{n:h[1]})};
  if(/^NPU sample expired$/i.test(s))return{text:tr("NPU sample expired")};
  if(/^No profiling samples in the aggregation window$/i.test(s))return{text:tr("No profiling samples in the aggregation window")};
  if(/^Required metrics for the selected model\/device are missing$/i.test(s))return{text:tr("Required metrics for the selected model/device are missing")};
  if(/^Selected endpoint did not collect successfully$/i.test(s))return{text:tr("Selected endpoint did not collect successfully")};
  if(/^Missing or invalid AgentX server metrics evidence; inspect collected artifacts$/i.test(s))return{text:tr("Missing or invalid AgentX server metrics evidence; inspect collected artifacts")};
  if(/^AgentX server metrics export is unavailable$/i.test(s))return{text:tr("AgentX server metrics export is unavailable")};
  return{text:s};
}
function splitErrors(list){
  const own=[],glob=[];
  (list||[]).forEach(e=>{const r=errCN(e);(r.global?glob:own).push(r);});
  return{own,glob};
}
const meanOf=x=>x&&x.mean!=null?x.mean:null;
// Bar group: drop missing values so null never enters the width calculation
const bars=(a,t,u,items)=>{const it=items.filter(i=>i.value!=null);if(it.length)a.push({title:t,unit:u,items:it});};
function seriesMap(src){const m={};(src&&src.series||[]).forEach(s=>{if(!(s.metric in m))m[s.metric]=s;});return m;}
function classifyDoc(o){
  if(!o||typeof o!=="object")return{kind:"unknown"};
  const sv=String(o.schema_version||o.schemaVersion||"");
  const attemptKey=o.attemptId||o.taskId||o.runId||o.session_id||null;
  if(Array.isArray(o.steps)||Array.isArray(o.subagent_trajectories)||/^ATIF/i.test(sv))
    return{kind:"trajectory",schema:sv||"ATIF",attemptKey};
  if(o.kind==="agentx"||o.metrics_phase||o.profiling||o.profiling_metrics||o.telemetry)
    return{kind:"summary",schema:sv||String(o.kind||"agentx"),attemptKey};
  return{kind:"unknown",schema:sv,attemptKey};
}
function parseDocs(text){
  const t=String(text||"").trim();
  if(!t)throw new Error("empty input");
  try{const o=JSON.parse(t);return Array.isArray(o)?o:[o];}catch(e){}
  return t.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map((line,i)=>{try{return JSON.parse(line);}catch(e){throw new Error("line "+(i+1)+": "+e.message);}});
}
function durOf(traj){const a=[];walkAll(traj,s=>{const x=stepStart(s),y=stepEnd(s);if(x!=null)a.push([x,y]);});
  if(!a.length)return "—";const t0=Math.min(...a.map(x=>x[0])),t1=Math.max(...a.map(x=>x[1]));return (t1-t0).toFixed(2)+"s";}
// Trace card summary: status dot + short model name + tokens, so a failing trace stands out at a glance
function trajMeta(traj){
  traj=traj||{};
  const steps=(traj.steps||[]).length,fm=traj.final_metrics||{},u=traj.usage||{};
  const tok=(fm.total_prompt_tokens!=null||fm.total_completion_tokens!=null)
    ?(fm.total_prompt_tokens||0)+(fm.total_completion_tokens||0)
    :(u.total_tokens!=null?u.total_tokens:null);
  const stt=String(traj.status||"").toLowerCase();
  const cls=(!stt?"none":/error|fail|timeout|invalid/.test(stt)?"bad":/run|pending|start|progress/.test(stt)?"warn":"");
  const ag=traj.agent||{},raw=String(ag.model_name||ag.name||"");
  const model=raw?(raw.indexOf("/")>=0?raw.split("/").slice(-1)[0]:raw):"";
  return {steps,cls,model,tok};
}
// trajectory.jsonl of an agentx profiling run only holds start/harness/end, with no agent steps.
// Such epochs show a run overview instead of a 0-step trace card, avoiding an empty waterfall on open.
function profilingOnly(){
  if(!SUMMARIES.size||!TRACES.length)return false;
  if(TRACES.some(t=>((t.traj&&t.traj.steps)||[]).length))return false;
  const kinds=[...SUMMARIES.values()].map(s=>String((s.workload&&s.workload.kind)||s.kind||""));
  return kinds.length>0&&kinds.every(k=>k==="agentx");
}
function renderProfView(){
  const el=$("#profview");if(!el)return;
  const s=[...SUMMARIES.values()][0]||{},w=s.workload||{};
  const cs=[...new Set([...SUMMARIES.values()].map(x=>(x.workload||{}).concurrency).filter(v=>v!=null))].sort((a,b)=>a-b);
  const attempts=TRACES.map(t=>t.traj||{}).slice().sort((a,b)=>(a.started_at||0)-(b.started_at||0));
  const kv=[["workload",w.kind||s.kind||"—"],["mode",w.mode||"—"],["variant",w.variant||"—"],
    ["concurrency",cs.length?cs.map(v=>"c"+v).join(" / "):"—"],
    [tr("Duration"),w.durationSeconds!=null?durText(w.durationSeconds):"—"],
    ["seed",w.seed!=null?w.seed:"—"],["dataset",w.dataset||"—"],["harness",s.harnessVersion||"—"]]
    .map(x=>`<div><span>${esc(x[0])}</span><b>${esc(String(x[1]))}</b></div>`).join("");
  const rows=attempts.map(t=>{
    const st=String(t.status||"—"),cls=/error|fail|timeout/.test(st)?"bad":/completed|ok|success/.test(st)?"ok":"";
    const dur=(t.started_at!=null&&t.ended_at!=null)?durText(t.ended_at-t.started_at):"—";
    const id=String(t.attempt_id||t.session_id||"—");
    return `<tr><td><code title="${esc(id)}">${esc(id.slice(0,8))}</code></td>`+
      `<td class="${cls}">${esc(st)}</td><td>${dtText(t.started_at)}</td><td>${dtText(t.ended_at)}</td><td class="num">${dur}</td></tr>`;
  }).join("");
  el.innerHTML=`<div class="phead"><h3>${tr("Run Overview")} <span class="cnt">${tr("profiling run · no agent steps")}</span></h3>`+
    `<div class="note">${tr("This run's trajectory.jsonl only records start / harness / end lifecycle events and no agent steps. Inference metrics, hardware metrics and measurement trust are on the Metrics tab.")}</div>`+
    `<div class="prof-kv">${kv}</div>`+
    `<h3>${tr("attempt lifeline")} <span class="cnt">${tr("{n} attempts",{n:attempts.length})}</span></h3>`+
    `<table class="epov"><thead><tr><th>attempt</th><th>${tr("Status")}</th><th>${tr("Start")}</th><th>${tr("End")}</th><th class="num">${tr("Duration")}</th></tr></thead>`+
    `<tbody>${rows||'<tr><td colspan="5">'+tr("No attempt events")+'</td></tr>'}</tbody></table>`+
    `<div style="margin-top:18px"><button id="profGoInf">${tr("View Metrics")}</button></div></div>`;
  const b=$("#profGoInf");if(b)b.onclick=()=>setTab("met");
}
function updateProfMode(){
  const on=profilingOnly(),pane=$("#pane-traj");if(!pane)return;
  pane.classList.toggle("prof-on",on);
  if(on)renderProfView();
  // On first entry (no tab in the URL), a profiling run lands on the metrics tab
  if(on&&AUTO_TAB){AUTO_TAB=false;syncSession(null);setTab("met");return;}
  if(TAB==="traj")updateMeta();
}
function renderNav(){const el=$("#trajList");$("#railCount").textContent=TRACES.length;
  el.innerHTML=TRACES.map((t,i)=>{const m=trajMeta(t.traj);
    return `<button class="trajitem ${i===ACTIVE?"on":""} ${m.cls==="bad"?"error":""}" data-i="${i}">`+
      `<span class="trow"><span class="tdot ${m.cls}"></span><span class="tcode">${tr("Trajectory {n}",{n:t.id})}</span>${t.isNew&&i!==ACTIVE?'<span class="tnew">NEW</span>':""}</span>`+
      `<small>${esc(t.session)}</small>`+
      `<span class="tmeta"><span class="cnt">${tr("{n} steps",{n:m.steps})}</span><span class="cnt">${durOf(t.traj)}</span>`+
      (m.model?`<span class="cnt">${esc(trunc(m.model))}</span>`:"")+
      (m.tok!=null?`<span class="cnt">${fmtNum(m.tok)} tok</span>`:"")+
      `</span></button>`;}).join("");}
function selectTrace(i,auto){const r=TRACES[i];if(!r)return;
  ACTIVE=i;SEL_KEY=null;USER_PICKED=!auto;
  TRACES.forEach(t=>{if(t.isNew)t.isNew=false;});
  build(r.traj);render();renderNav();syncSession(r.session);
  $("#details").innerHTML='<div class="emptyfull">'+emptyHTML(tr("No step selected"),tr("Click a bar on the left to inspect its metrics and tool calls"))+'</div>';
  if(window.__closeDrawers)window.__closeDrawers();}
// Live pushes rebuild and resend a whole trajectory for the same attempt: upsert by session,
// otherwise the trace rail gains a duplicate card every second.
// ?session= restore target: suppress "auto-select new trace" while waiting, or every trace
// that arrives during replay steals the selection, the cursor jumps to the end and back, visibly flickering.
let PENDING_SESSION=null;
// The feedback pane can render before trace replay, when evidence anchors find no trace and degrade to plain text;
// batch the refresh once traces arrive so buttons regenerate from real data (avoids per-item flicker).
let FBTIMER=null;
function scheduleFbRefresh(){
  if(TAB!=="fb")return;
  const box=$("#fbpane");
  if(box&&box.innerHTML.indexOf(tr("not in this epoch"))<0&&box.innerHTML.indexOf(tr("no execution trace"))<0)return;
  clearTimeout(FBTIMER);
  FBTIMER=setTimeout(()=>{if(TAB==="fb")loadFeedback();},700);
}
function addTrace(o){
  const session=(o.session_id||o.trajectory_id||("trace-"+(TRACEID+1)));
  const i=TRACES.findIndex(t=>t.session===session);
  if(i>=0){TRACES[i].traj=o;if(ACTIVE===i){build(o);render();}renderNav();updateProfMode();scheduleFbRefresh();return;}
  // Once the user picked a trace manually, newly arriving traces are only flagged NEW and no longer steal the view
  const mark=!PENDING_SESSION&&USER_PICKED;
  TRACES.push({id:++TRACEID,traj:o,session,isNew:mark});if(TRACES.length>100)TRACES.shift();
  if(!PENDING_SESSION&&!mark){ACTIVE=TRACES.length-1;build(o);render();if(!profilingOnly())syncSession(TRACES[ACTIVE].session);}
  renderNav();updateProfMode();scheduleFbRefresh();}
// Write the selected trace into the URL (?session=) so refresh or a shared link restores it; null clears it
function syncSession(s){const u=new URL(location.href);
  if(s)u.searchParams.set("session",s);else u.searchParams.delete("session");
  history.replaceState(null,"",u);}
const $=s=>document.querySelector(s);
let toastTimer=null;
function toast(msg){let t=$("#toast");if(!t){t=document.createElement("div");t.id="toast";t.className="toast";document.body.appendChild(t);}
  t.textContent=msg;t.style.opacity="1";clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.style.opacity="0",2600);}
let TRAJ=null,ROWS=[],T0=0,T1=1,ANYREAL=false,SEQ=0,STEPS=[],VIEW="waterfall",DATA0=0,DATA1=1,VS=0,VE=1;
// Selected row: keyed by step_id+tool because row ids change on live rebuild and would lose the highlight
let SEL_KEY=null,CUR_ROWS=[],CUR_ROW=null,CUR_STEP=null;
// Once the user picked a trace manually, new live traces no longer steal the view; FILTER holds the current query
let USER_PICKED=false,FILTER="";
const ERR_STATUS=new Set(["error","failed","failure","timeout"]);
// Row key: the name column and track column each hold a DOM node, highlighted together via this key.
// Flame rows in aggregate/expanded views have no step field, so read it from occ;
// otherwise every row becomes "rundefined", selecting one highlights the whole column and ↑↓ never leaves the first row.
const rowKey=r=>{const st=r.step||(r.occ&&r.occ[0]);
  if(st)return "s"+st.step_id+(r.tool==null?"":":t"+r.tool);return "r"+r.id;};
// The event generator writes step_id as "s49"; the UI shows the bare number while data and filters keep the raw value
const stepNo=id=>String(id==null?"":id).replace(/^s(?=\d)/,"");
const rowErr=r=>{const st=r.step||(r.occ&&r.occ[0]);if(!st)return false;
  const inv=(st.extra&&st.extra.invocation)||{};return ERR_STATUS.has(String(inv.status||st.status||"").toLowerCase());};
// Shared empty/error block: title + description, callers only pass the copy
const emptyHTML=(title,desc,cls)=>'<div class="empty '+(cls||"")+'"><b>'+esc(title)+'</b>'+(desc?'<span>'+desc+'</span>':"")+'</div>';
function relTime(d){const s=(Date.now()-d.getTime())/1000;
  if(s<60)return tr("just now");if(s<3600)return tr("{n} min ago",{n:Math.floor(s/60)});
  if(s<86400)return tr("{n} h ago",{n:Math.floor(s/3600)});return tr("{n} d ago",{n:Math.floor(s/86400)});}
// JSON highlighting: only keys, strings, numbers and booleans; that is enough to read it
function jsonHL(txt){
  return esc(txt).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,(m,str,col,bn)=>{
    if(str)return '<span class="'+(col?"hl-k":"hl-s")+'">'+str+"</span>"+(col||"");
    if(bn)return '<span class="hl-b">'+bn+"</span>";
    return '<span class="hl-n">'+m+"</span>";});
}
// Lightweight markdown: fenced blocks, inline code and bold; everything else stays as-is (LaTeX is not parsed)
function mdHTML(v){
  if(v==null)return"";
  let s=typeof v==="string"?v:(Array.isArray(v)?v.map(p=>typeof p==="string"?p:((p&&p.text)||"")).join("\n"):JSON.stringify(v,null,2));
  const inline=t=>t.replace(/`([^`\n]+)`/g,"<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g,"<b>$1</b>");
  const re=/```[^\n]*\n?([\s\S]*?)```/g;
  let out="",last=0,m;
  while((m=re.exec(s))){
    out+=inline(esc(s.slice(last,m.index)))+'<pre class="code">'+esc(m[1].replace(/\s+$/,""))+"</pre>";
    last=m.index+m[0].length;
  }
  return out+inline(esc(s.slice(last)));
}
const T=new WeakMap(),COLLAPSED=new Set();
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmtNum=n=>n==null?"—":Number(n).toLocaleString();
// Aligned with delta.MIN_TASKS in the backend: below this sample count the statistics do not hold
const MIN_TASKS=20;
// Adaptive time units: raw milliseconds such as 2270415ms are unreadable
function dur(ms,signed){
  if(ms==null||isNaN(ms))return"—";
  const v=Number(ms),s=(signed&&v>0)?"+":"";
  if(Math.abs(v)<1000)return s+v.toFixed(0)+" ms";
  if(Math.abs(v)<60000)return s+(v/1000).toFixed(1)+" s";
  return s+(v/60000).toFixed(1)+" min";
}
const trunc=s=>{s=String(s||"");return s.length>42?s.slice(0,42)+"…":s;};
const fmt=v=>typeof v==="string"?v:JSON.stringify(v,null,2);
function stepStart(st){const i=st.extra&&st.extra.invocation;if(i&&i.start_timestamp!=null)return i.start_timestamp;if(st.timestamp){const t=Date.parse(st.timestamp);if(!isNaN(t))return t/1000;}return null;}
function stepEnd(st){const i=st.extra&&st.extra.invocation;if(i&&i.end_timestamp!=null)return i.end_timestamp;const s=stepStart(st);return s==null?null:s+.5;}
// Real duration: rendering pads missing spans with a synthetic width, so restore the truth here;
// instant events (user.input etc.) are 0, steps without any timestamp are null.
function realDur(o){if(!o||o.s==null||o.synth)return null;if(o.inst)return 0;return +(o.e-o.s).toFixed(3);}
function shortMsg(m){if(m==null)return"";if(typeof m==="string")return trunc(m);if(Array.isArray(m))return trunc(m.map(p=>typeof p==="string"?p:(p.text||p.type||"")).join(" "));return trunc(JSON.stringify(m));}
// Step categorization: only message / tool_calls / observation together explain what a step does.
// message appears only on user input and final answers, tool output lives in observation.content,
// tool requests sit in tool_calls. Classifying by source alone renders 148 bash calls as one identical kind.
function stepCat(st){
  const anc=(st.extra&&st.extra.ancestry)||{};
  const fn=String(anc.function_name||st.source||"");
  const obs=st.observation||{};
  const hasObs=!!(obs.content&&String(obs.content).trim())||!!(obs.results&&obs.results.length);
  const tcs=st.tool_calls||[];
  if(st.source==="user")return{k:"user",t:tr("user input")};
  if(/llm|model|chat|completion/i.test(fn))return tcs.length?{k:"llm_req",t:tr("model decision")}:{k:"llm_resp",t:tr("model reply")};
  if(hasObs)return{k:"tool_resp",t:tr("tool result")};
  if(tcs.length)return{k:"tool_req",t:tr("tool call")};
  if(typeof st.message==="string"&&st.message.trim())return{k:"msg",t:tr("text output")};
  return{k:"sys",t:tr("system")};
}
// Tool results have an empty message; use the first observation line as subtitle, or the column is a wall of "bash"
function stepSub(st){
  const m=shortMsg(st.message);
  if(m)return m;
  const obs=st.observation||{};
  if(obs.content)return trunc(String(obs.content).replace(/\s+/g," ").trim());
  const tcs=st.tool_calls||[];
  if(tcs.length)return trunc("→ "+tcs.map(t=>t.function_name).join(", "));
  return "";
}

function build(traj){
  TRAJ=Array.isArray(traj)?traj[0]:traj;ROWS=[];SEQ=0;STEPS=[];COLLAPSED.clear();
  walkAll(TRAJ,s=>STEPS.push(s));
  STEPS.forEach(s=>T.set(s,{s:stepStart(s),e:stepEnd(s)}));
  const real=STEPS.map(s=>T.get(s).s).filter(v=>v!=null);ANYREAL=real.length>0;
  let prev=ANYREAL?Math.min(...real):0;
  STEPS.forEach((s,i)=>{const o=T.get(s);if(!ANYREAL){o.s=i;o.e=i+1;o.synth=true;}
    else{if(o.s==null){o.s=prev;o.synth=true;}if(o.e==null||o.e<=o.s){o.e=o.s+.6;o.inst=true;}prev=o.e;}});
  if(ANYREAL){
    // End time uses only steps with real spans; the synthetic 0.6s of instant events must not inflate the total.
    const ends=STEPS.map(s=>T.get(s)).filter(o=>!o.inst&&!o.synth).map(o=>o.e);
    T0=Math.min(...STEPS.map(s=>T.get(s).s));
    T1=ends.length?Math.max(...ends):Math.max(...STEPS.map(s=>T.get(s).e));
  }else{T0=0;T1=Math.max(1,STEPS.length);}
  if(T1<=T0)T1=T0+1;
  DATA0=T0;DATA1=T1;VS=T0;VE=T1;
  buildFor(TRAJ,0,null);
  const rootId=++SEQ,nTraj=(ACTIVE>=0&&TRACES[ACTIVE])?TRACES[ACTIVE].id:(TRACEID||1);
  ROWS.forEach(r=>{r.depth+=1;if(r.parent==null)r.parent=rootId;});
  ROWS.unshift({id:rootId,parent:null,depth:0,kind:"traj",label:tr("Trajectory {n}",{n:nTraj}),sub:(TRAJ.session_id||""),s:T0,e:T1,hasChildren:true});
  // The system prompt has no start/end of its own, yet it is the trace's first input:
  // synthesize a row before the user steps, otherwise this data is only reachable via top-level fields.
  const sp=typeof TRAJ.system_prompt==="string"?TRAJ.system_prompt.trim():"";
  if(sp)ROWS.splice(1,0,{id:++SEQ,parent:rootId,depth:1,kind:"system",cat:{k:"sys",t:tr("system prompt")},label:"system prompt",
    sub:trunc(sp),s:T0,e:T0,inst:true,sysPrompt:sp});
}
function walkAll(root,cb){(root.steps||[]).forEach(cb);(root.subagent_trajectories||[]).forEach(s=>walkAll(s,cb));}
function subsOf(st){const out=[],seen=new Set(),o=st.observation;if(!o||!o.results)return out;
  o.results.forEach(r=>(r.subagent_trajectory_ref||[]).forEach(ref=>{
    const m=(TRAJ.subagent_trajectories||[]).find(s=>s.trajectory_id===ref.trajectory_id||s.session_id===ref.session_id);
    if(m&&!seen.has(m)){seen.add(m);out.push(m);}}));return out;}
function spanOf(steps){const a=(steps||[]).map(s=>T.get(s)).filter(Boolean);return a.length?{s:Math.min(...a.map(t=>t.s)),e:Math.max(...a.map(t=>t.e))}:{s:T0,e:T0};}
function buildFor(root,depth,parentId){
  (root.steps||[]).forEach(st=>{
    const o=T.get(st),anc=st.extra&&st.extra.ancestry,id=++SEQ,subs=subsOf(st);
    ROWS.push({id,parent:parentId,depth,kind:st.source||"agent",cat:stepCat(st),label:(anc&&anc.function_name)||st.source||"step",sub:stepSub(st),s:o.s,e:o.e,step:st,inst:!!(o.inst||o.synth),hasChildren:subs.length>0});
    const tcs=st.tool_calls||[],tinvs=(st.extra&&st.extra.tool_invocations)||[];
    tcs.forEach((tc,j)=>{const ti=tinvs[j]||{};let ts=ti.start_timestamp,te=ti.end_timestamp;
      if(ts==null||te==null){const k=tcs.length;ts=o.s+(o.e-o.s)*j/k;te=o.s+(o.e-o.s)*(j+1)/k;}
      ROWS.push({id:++SEQ,parent:id,depth:depth+1,kind:"tool",cat:{k:"tool_req",t:tr("tool call")},label:tc.function_name,sub:argPreview(tc.arguments),s:ts,e:te,step:st,tool:j});});
    subs.forEach(sub=>{const sp=spanOf(sub.steps),sid=++SEQ;
      ROWS.push({id:sid,parent:id,depth:depth+1,kind:"subagent",label:"⤷ "+((sub.agent&&sub.agent.name)||"subagent"),sub:tr("{n} steps",{n:(sub.steps||[]).length}),s:sp.s,e:sp.e,subagent:sub,hasChildren:true});
      COLLAPSED.add(sid);buildFor(sub,depth+1,sid);});
  });
}
function visibleRows(){const byId=new Map(ROWS.map(r=>[r.id,r]));
  return ROWS.filter(r=>{let p=r.parent;while(p!=null){if(COLLAPSED.has(p))return false;const pr=byId.get(p);if(!pr)break;p=pr.parent;}return true;});}
// Attempt behind the selected trace: traces from Evaluator events have no separate session,
// session_id is the attempt_id, so always read it here to avoid showing another trace's id.
function activeAttempt(){
  const t=(ACTIVE>=0&&TRACES[ACTIVE])?TRACES[ACTIVE]:null;
  return (t&&(t.traj.attempt_id||t.traj.session_id||t.session))||ATTEMPT.key||null;}
// In a profiling run the attempt task name looks like agentx-256k-standard-c8, which reveals the concurrency level;
// the metrics page aggregates three summaries, so the header has to list all three attempts.
function profAttempts(){
  const seen=new Set(),out=[];
  TRACES.forEach(t=>{
    const id=t.traj.attempt_id||t.traj.session_id||t.session;
    if(!id||seen.has(id))return;
    seen.add(id);
    const m=String(t.traj.task_id||"").match(/-c(\d+)$/);
    out.push({attempt:id,conc:m?Number(m[1]):null});
  });
  return out;
}
function metaTraj(){
  if(!TRAJ)return '<span style="color:var(--dim)">'+tr("No trajectory loaded")+'</span>';
  if(profilingOnly())return `<b>agentx profiling</b> · <code>${TRACES.length}</code> ${tr("attempts")} · ${tr("no agent steps")}`;
  const m=TRAJ.agent||{},aid=activeAttempt(),sid=TRAJ.session_id||"";
  const id=(sid&&sid!==aid)?" · session <code>"+esc(sid)+"</code>":"";
  // No longer duplicated: the bold agent name is dropped, only the model field remains.
  // The epoch dropdown now reads "short id · candidate · status", so it can no longer backfill the model.
  const eo=(EPOCHS||[]).find(x=>x.epoch===CUR_EPOCH)||{};
  const model=m.model_name||(m.name&&m.name.indexOf("/")>=0?m.name:"")||eo.model||eo.model_name||"—";
  return `model <code>${esc(model)}</code>`+id;
}
function metaMetrics(){
  const s=METRICS_RAW;
  // Metric status belongs to the metrics tab; a "metrics not loaded" note above the feedback pane contradicts what is already rendered
  if(!s)return '<span style="color:#6e7681">'+tr("metrics not reported")+'</span>';
  const srcs=(s.telemetry&&s.telemetry.sources)||[],kinds=srcs.map(x=>x.kind).join(", ")||"—";
  // Multi-level runs (agentx standard c1/c4/c8) show the level count in the top bar so it is not mistaken for a single dataset
  const pts=SUMMARIES.size;
  // Metrics are camelCase (schemaVersion / workload.mode) while old artifacts are snake_case; accept both to avoid a row of "—"
  return `<b>${tr("Metrics")}</b> · schema <code>${esc(s.schemaVersion||s.schema_version||"—")}</code> · mode <code>${esc((s.workload&&s.workload.mode)||s.metrics_phase||"—")}</code>`+
    (pts>1?` · ${tr("{n} tiers",{n:pts})}`:"")+` · ${tr("data sources")} <code>${esc(kinds)}</code>`;
}
function updateMeta(){const base=SNAP?SNAP_HEAD:(TAB==="traj"?metaTraj():TAB==="fb"?"":metaMetrics());const extra=[];
  // A profiling run has several attempts; the top bar must not single one out, or it looks like only one ran
  let ak=(TAB==="traj"&&profilingOnly())?null:(TAB==="traj"?activeAttempt():ATTEMPT.key);
  // Metrics and feedback tabs aggregate at epoch level, so with multiple levels do not show only the last imported attempt
  if((TAB==="met"||TAB==="fb")&&SUMMARIES.size>1){
    // agentx profiling attempts come from traces since the summary carries no attemptId;
    // other multi-summary cases fall back to SUM_META.
    const rows=profilingOnly()?profAttempts()
      :[...SUM_META.values()].filter(v=>v.attempt).map(v=>({attempt:v.attempt,conc:v.conc}));
    const ids=[...new Set(rows.map(v=>v.attempt))];
    if(ids.length>1){
      ak=null;
      const map=rows.map(v=>(v.conc!=null?"c"+v.conc:tr("single tier"))+" "+v.attempt).join("\n");
      extra.push("attempt <code title='"+esc(map)+"'>"+ids.length+" "+tr("attempts")+"</code>");
    }
  }
  // Show only 8 chars of the uuid with the full value in title; a 36-char string must not stretch the top bar
  if(ak)extra.push("attempt <code title='"+esc(ak)+"'>"+esc(String(ak).slice(0,8))+"</code>");
  if(ATTEMPT.warn)extra.push('<span style="color:#f85149">⚠ '+esc(ATTEMPT.warn)+"</span>");
  $("#meta").innerHTML=(base+(extra.length?" · "+extra.join(" · "):"")).replace(/^ · /,"");}
// Reward lives in outcomes (keyed by task_id), not in the trajectory payload, so load it per epoch
let REWARDS=null,REWARDS_EPOCH="",REWARDS_PENDING=false;
function ensureRewards(){
  const ep=CUR_EPOCH;
  if(!ep||ep===REWARDS_EPOCH||REWARDS_PENDING)return;
  REWARDS_PENDING=true;
  fetch(apiUrl("/v1/outcomes?epoch="+encodeURIComponent(ep))).then(r=>r.json()).then(d=>{
    REWARDS=d.outcomes||[];REWARDS_EPOCH=ep;REWARDS_PENDING=false;render();
  }).catch(()=>{REWARDS_PENDING=false;});
}
function outcomeOf(t){
  const id=t&&t.task_id;
  if(id==null||!REWARDS||REWARDS_EPOCH!==CUR_EPOCH)return null;
  return REWARDS.find(o=>String(o.task_id)===String(id))||null;
}
function render(){
  // Collapse controls and shortcut hints only make sense for the waterfall view
  const wf=(VIEW==="waterfall");
  ["expandAll","collapseAll"].forEach(id=>{document.getElementById(id).style.display=wf?"":"none";});
  document.querySelectorAll("#wftools .hint").forEach(el=>{el.style.display=wf?"":"none";});
  if(!TRAJ){$("#summary").innerHTML="";$("#axis").innerHTML="";$("#namesBody").innerHTML="";$("#tracksBody").innerHTML="";$("#fcount").textContent="";updateMeta();return;}
  const fm=totalsOf();
  updateMeta();
  ensureRewards();
  const oc=outcomeOf(TRAJ),rw=oc&&oc.reward;
  // Green for a pass and red for a failure; a missing outcome stays neutral instead of pretending to be 0
  const rwCls=!oc?"nul":(oc.success?"ok":"bad");
  const rwTxt=rw==null?"—":String(Math.round(rw*1000)/1000);
  const rwTitle=oc?tr("task {id} · reward {rw} · {status}",{id:String(TRAJ.task_id||"—"),rw:rwTxt,status:oc.success?tr("passed"):tr("failed")}):tr("no evaluation result");
  const st=(l,v)=>`<div class="stat"><span>${l}</span><b class="${v==="—"?"nul":""}">${v}</b></div>`;
  // Group summary stats by time / tokens / cost; seven flat numbers are hard to scan
  $("#summary").innerHTML=
    '<div class="statgrp">'+st(tr("steps"),STEPS.length)+st(tr("duration"),(T1-T0).toFixed(2)+"s")+'</div>'+
    '<div class="statgrp">'+st(tr("prompt tok"),fmtNum(fm.total_prompt_tokens))+st(tr("completion tok"),fmtNum(fm.total_completion_tokens))+st(tr("cached tok"),fmtNum(fm.total_cached_tokens))+'</div>'+
    '<div class="statgrp">'+st(tr("cost"),fm.total_cost_usd!=null?"$"+fm.total_cost_usd.toFixed(4):"—")+st(tr("subagents"),countSub(TRAJ))+
    `<div class="stat" title="${esc(rwTitle)}"><span>reward</span><b class="${rwCls}">${esc(rwTxt)}</b></div></div>`;
  const span=VE-VS;
  // Ticks snap to 1/2/5×10^n; a fixed 4/5 split yields ticks like 0.37s once zoomed
  const px=$("#axis").clientWidth||800,want=Math.max(3,Math.floor(px/110));
  const step=niceStep(span/want);
  let ax="";const first=Math.ceil((VS-DATA0)/step)*step+DATA0;
  for(let i=0;;i++){const t=first+i*step;if(t>VE+1e-9)break;
    ax+=`<div class="tick" style="left:${(t-VS)/span*100}%"><span>${(t-DATA0).toFixed(2)}s</span></div>`;}
  $("#axis").innerHTML=ax;
  const zw=$("#zwin");if(zw){zw.textContent=(span<DATA1-DATA0-1e-6)?tr("window {n}s",{n:span.toFixed(2)}):"";}
  const raw=VIEW==="waterfall"?visibleRows():flameRows(VIEW==="agg"?"agg":"exp");
  const list=applyFilter(raw,VIEW==="waterfall");
  $("#fcount").textContent=FILTER?list.length+"/"+raw.length+" "+tr("rows"):"";
  renderRows(list);
}
// "Nice" tick interval at 1/2/5×10^n
function niceStep(raw){if(!isFinite(raw)||raw<=0)return 1;
  const p=Math.pow(10,Math.floor(Math.log10(raw))),m=raw/p;
  return (m<=1?1:m<=2?2:m<=5?5:10)*p;}
// Filter on function, tool, source, step_id or status; the "error" keyword means failed steps only
function rowHit(r){
  if(!FILTER)return true;
  const st=r.step||(r.occ&&r.occ[0])||{};
  const tc=(r.tool!=null&&st.tool_calls&&st.tool_calls[r.tool])?st.tool_calls[r.tool].function_name:"";
  const inv=(st.extra&&st.extra.invocation)||{};
  const hay=[r.label,st.source,st.step_id,tc,inv.status||st.status||"",(r.cat&&r.cat.t)||""].join(" ").toLowerCase();
  return FILTER.toLowerCase().split(/\s+/).filter(Boolean).every(q=>{
    if(q==="error"||q==="failed"||q==="失败")return rowErr(r);
    return hay.indexOf(q)>=0;});
}
function applyFilter(list,hier){
  if(!FILTER)return list;
  if(!hier)return list.filter(rowHit);
  // The waterfall keeps all ancestors of matched rows, otherwise the hierarchy breaks once a child matches
  const byId=new Map(list.map(r=>[r.id,r])),keep=new Set();
  list.forEach(r=>{if(!rowHit(r))return;keep.add(r.id);let p=r.parent;
    while(p!=null&&!keep.has(p)){keep.add(p);const pr=byId.get(p);p=pr?pr.parent:null;}});
  return list.filter(r=>keep.has(r.id));
}
function countSub(t){let n=0;(t.subagent_trajectories||[]).forEach(s=>n+=1+countSub(s));return n;}
// Older traces (stored before the rebuild) have no final_metrics; fall back to summing per-step metrics.
function totalsOf(){
  const t=Object.assign({},(TRAJ&&TRAJ.final_metrics)||{});
  const sum=k=>STEPS.reduce((a,s)=>a+((((s.metrics||{})[k])||0)),0);
  [["prompt_tokens","total_prompt_tokens"],["completion_tokens","total_completion_tokens"],["cached_tokens","total_cached_tokens"]]
    .forEach(([k,out])=>{if(t[out]==null){const v=sum(k);if(v)t[out]=v;}});
  return t;
}
function renderRows(list){
  const nb=$("#namesBody"),tb=$("#tracksBody");
  // Live pushes rebuild every second; save the scroll position first, or the step being read jumps to the top
  const keep=tb.scrollTop;
  CUR_ROWS=list;nb.innerHTML="";tb.innerHTML="";
  list.forEach(r=>{
    // Instant/untimed steps have no real span: draw a thin marker instead of faking a 0.6s bar width.
    const span=(VE-VS)||1,left=(r.s-VS)/span*100,w=r.inst?.4:Math.max(.4,(r.e-r.s)/span*100),flame=VIEW!=="waterfall";
    const k=rowKey(r),sel=(k===SEL_KEY)?" sel":"",err=rowErr(r);
    const caret=r.hasChildren?`<span class="caret">${COLLAPSED.has(r.id)?"▸":"▾"}</span>`:(flame?"":`<span class="caret"></span>`);
    // Hierarchy guides: a vertical line beside the indent, so parent/child stays visible in deep call stacks
    let guides="";for(let i=0;i<r.depth;i++)guides+=`<span class="guide" style="left:${14+i*16}px"></span>`;
    const cnt=(r.count&&r.count>1)?` <span class="cnt">×${r.count}</span>`:"";
    // Aggregate rows size the bar by active range but show cumulative time; expanded/waterfall rows show the same value
    const busy=r.busy!=null?r.busy:(r.e-r.s);
    const dur=r.inst?"":(busy.toFixed(2)+"s");
    const nm=document.createElement("div");nm.className="wf-row"+sel;nm.dataset.id=r.id;nm.dataset.key=k;
    nm.innerHTML=`<div class="wf-name" style="padding-left:${8+r.depth*16}px">${guides}${caret}${r.cat?'<span class="cat '+r.cat.k+'">'+esc(r.cat.t)+'</span>':'<span class="dot '+r.kind+'"></span>'}${err?'<span class="errmark" title="'+tr("this step failed")+'">✗</span>':""}${esc(r.label)}${cnt} <small>${esc(r.sub||"")}</small><span class="durv">${dur}</span></div>`;
    const track=document.createElement("div");track.className="wf-row"+sel;track.dataset.id=r.id;track.dataset.key=k;
    // Aggregate/expanded views reuse source colors; only rows that really merged several calls get an outline
    track.innerHTML=`<div class="wf-track"><div class="wf-bar ${err?"err":r.kind}${r.agg?" agg":""}" style="left:${left}%;width:${w}%" title="${esc(r.label)}${r.count>1?tr(" · {n} calls · cumulative {busy}s · active {from}s → {to}s",{n:r.count,busy:busy.toFixed(2),from:(r.s-DATA0).toFixed(2),to:(r.e-DATA0).toFixed(2)}):(r.inst?tr(" · instant event"):" · "+busy.toFixed(2)+"s")}">${r.inst?"":busy.toFixed(2)+"s"}</div></div>`;
    if(r.hasChildren){nm.querySelector(".caret").onclick=e=>{e.stopPropagation();COLLAPSED.has(r.id)?COLLAPSED.delete(r.id):COLLAPSED.add(r.id);render();};}
    nm.onclick=()=>details(r);track.onclick=()=>details(r);nb.appendChild(nm);tb.appendChild(track);});
  nb.scrollTop=keep;tb.scrollTop=keep;
}
