let CUR_EPOCH=new URLSearchParams(location.search).get("epoch")||"",EPOCHS=[];
// Without an epoch param in the URL, follow the latest run; once the user picks an epoch manually, pin it so new runs cannot steal the view.
let FOLLOW_LATEST=!CUR_EPOCH;
function resetView(){
  TRACES.length=0;ACTIVE=-1;TRACEID=0;TRAJ=null;ROWS=[];STEPS=[];SEQ=0;COLLAPSED.clear();
  METRICS=null;METRICS_RAW=null;ATTEMPT={key:null,trajKey:null,sumKey:null,warn:null};SUMMARIES.clear();SUM_META.clear();
  PENDING_SESSION=null;SEL_KEY=null;CUR_ROWS=[];CUR_ROW=null;CUR_STEP=null;
  USER_PICKED=false;FILTER="";const f=$("#filter");if(f)f.value="";
  $("#trajList").innerHTML="";$("#railCount").textContent="0";
  $("#namesBody").innerHTML="";$("#tracksBody").innerHTML="";$("#summary").innerHTML="";$("#fcount").textContent="";
  $("#details").innerHTML='<div class="emptyfull">'+emptyHTML(tr("No step selected"),tr("Click a bar on the left to inspect its metrics and tool calls"))+'</div>';
  renderMetrics();updateProfMode();updateMeta();
}
function syncEpoch(ep){if(!ep)return;CUR_EPOCH=ep;const sel=$("#epochSel");if(sel)sel.value=ep;}
window.__syncEpoch=syncEpoch;
// auto=true means a background follow switch that keeps following; a manual switch pins this epoch.
window.__setEpoch=setEpoch;
window.__followLatest=function(){return FOLLOW_LATEST;};
// The live badge shows the step count of the trajectory on this page, not the number of pushed events.
window.__stepCount=function(){return STEPS.length;};
function setEpoch(ep,auto){
  CUR_EPOCH=ep||"";
  FOLLOW_LATEST=auto===true;
  const u=new URL(location.href);
  if(CUR_EPOCH)u.searchParams.set("epoch",CUR_EPOCH);else u.searchParams.delete("epoch");
  // A session is bound to a trajectory under a specific epoch, so it is always stale after switching;
  // if kept, SSE replays by session+epoch and finds nothing, showing "no trajectory loaded".
  u.searchParams.delete("session");
  if(typeof window.__clearSession==="function")window.__clearSession();
  history.replaceState(null,"",u);
  if(typeof window.__liveConnect!=="function"){
    location.replace(u.toString());
    return;
  }
  resetView();
  // Panel content belongs to the previous trajectory/epoch and must be cleared to avoid stale analysis.
  const ai=$("#aipanel"),ab=$("#aiback");if(ai)ai.classList.remove("on");if(ab)ab.classList.remove("on");
  const aib=$("#aibody");if(aib)aib.innerHTML="";
  loadEpochs();
  window.__liveConnect(CUR_EPOCH);
  if(TAB==="fb")loadFeedback();
}
async function loadEpochs(){
  try{
    const r=await fetch(apiUrl("/v1/epochs"));if(!r.ok)throw new Error("HTTP "+r.status);
    const d=await r.json();EPOCHS=d.epochs||[];
    const sel=$("#epochSel");
    // Raw uuids alone make runs indistinguishable: use short id + candidate + status + relative time.
    const label=e=>{
      const id=String(e.epoch||""),bits=[id.length>12?id.slice(0,8):id];
      // candidate is often manual-<short epoch id>, so skip it when it repeats the id shown on the left.
      const cd=String(e.candidate_id||"").replace(/^manual-/,"");
      if(cd&&!id.startsWith(cd.slice(0,8)))bits.push(cd.slice(0,8));
      if(e.status)bits.push(String(e.status));
      const t=e.finished_at||e.updated_at||e.last_at||e.ended_at||null;
      if(t!=null){const ts=Number(t),dt=new Date(ts>1e12?ts:ts*1000);if(!isNaN(dt.getTime()))bits.push(relTime(dt));}
      return bits.join(" · ");
    };
    const names=EPOCHS.map(e=>e.epoch);
    let opts='<option value="">'+tr("All")+'</option>'+EPOCHS.map(e=>'<option value="'+esc(e.epoch)+'">'+esc(label(e))+'</option>').join("");
    if(CUR_EPOCH&&!names.includes(CUR_EPOCH))opts+='<option value="'+esc(CUR_EPOCH)+'">'+esc(CUR_EPOCH.slice(0,8))+'</option>';
    sel.innerHTML=opts;sel.value=CUR_EPOCH;
  }catch(e){}
}
$("#epochSel").onchange=e=>setEpoch(e.target.value);
function epRow(e,d){
  const p=(d&&d.population)||{},c=(d&&d.candidate)||{},sigs=((d&&d.signals)||[]).length;
  const vd=(d&&d.conclusion&&d.conclusion.verdict)||{};
  const nn=v=>v==null?"—":v;
  // Profiling runs have no task results; showing 0 for tasks/success/latency/steps misleads, so use — instead.
  const prof=!!(d&&d.profiling);
  const money=p.cost_usd!=null&&p.tasks?("$"+(p.cost_usd/p.tasks).toFixed(4)):"—";
  // Color status and success rate so healthy/failed/low states are distinguishable at a glance.
  const stt=String(e.status||"—");
  const scls=/^(finished|done|ok|success|completed)$/i.test(stt)?"ok":/^(error|failed|invalid|timeout)$/i.test(stt)?"bad":"";
  const sr=p.success_rate;
  const vcls=sr==null?"":(sr>=0.999?"ok":sr>=0.5?"warn":"bad");
  // Verdict column: the decision deserves attention before raw metrics.
  const VL={accept:[tr("Accepted"),"ok"],reject:[tr("Rejected"),"bad"],inconclusive:[tr("Inconclusive"),"warn"]};
  const vv=VL[vd.decision];
  // Profiling runs have no task success verdict; leave the cell empty so it is not read as "inconclusive".
  const verdictCell=prof?'<span class="hint">—</span>':(vv?'<span class="stchip '+vv[1]+'">'+vv[0]+'</span>':'<span class="hint">—</span>');
  return '<tr data-epoch="'+esc(e.epoch)+'"><td><b>'+esc(e.epoch)+'</b></td>'+
    '<td>'+verdictCell+'</td>'+
    '<td>'+esc(c.candidate_id||e.candidate_id||"—")+'</td>'+
    '<td><span class="stchip '+scls+'">'+esc(stt)+'</span>'+(prof?' <span class="stchip">profiling</span>':'')+'</td>'+
    '<td class="num">'+(prof?"—":nn(p.tasks))+'</td>'+
    '<td class="num"><span class="sv '+vcls+'">'+(prof?"—":(sr!=null?(sr*100).toFixed(1)+"%":"—"))+'</span></td>'+
    '<td class="num">'+(prof?"—":dur(p.p50_latency_ms))+'</td>'+
    '<td class="num">'+(prof?"—":dur(p.p95_latency_ms))+'</td>'+
    '<td class="num">'+(prof?"—":money)+'</td>'+
    '<td class="num">'+(prof?"—":nn(p.steps_mean))+'</td>'+
    '<td class="num">'+sigs+'</td></tr>';
}
async function loadOverview(){
  const box=document.getElementById("fbpane");
  box.innerHTML='<div class="empty"><span class="spin"></span>'+tr("Loading epoch list…")+'</div>';
  try{
    await loadEpochs();
    if(!EPOCHS.length){box.innerHTML=emptyHTML(tr("No epochs yet"),tr("Wait for an evaluation run to finish, or confirm the Collector received an ingest"));return;}
    const fbs=await Promise.all(EPOCHS.map(e=>fetch(apiUrl("/v1/feedback?epoch="+encodeURIComponent(e.epoch)))
      .then(r=>r.ok?r.json():null).catch(()=>null)));
    let h='<h3>'+tr("Optimization Feedback · all epochs")+'</h3><div class="mtitle">'+tr("{n} epochs (newest first) · click a row for that epoch",{n:EPOCHS.length})+'</div>';
    h+='<table class="epov"><thead><tr><th>epoch</th><th>'+tr("Verdict")+'</th><th>candidate</th><th>status</th><th class="num">tasks</th><th class="num">success</th><th class="num">P50</th><th class="num">P95</th><th class="num">cost/task</th><th class="num">steps</th><th class="num">signals</th></tr></thead><tbody>'+
      EPOCHS.map((e,i)=>epRow(e,fbs[i])).join("")+'</tbody></table>';
    h+='<div class="kv" style="margin-top:10px">'+tr("Delta needs a single parent; open a specific epoch to see it.")+'</div>';
    box.innerHTML=h;
  }catch(e){box.innerHTML=emptyHTML(tr("Failed to load feedback"),esc(e.message),"error");}
}
document.getElementById("fbpane").onclick=e=>{
  const row=e.target.closest("tr[data-epoch]");if(!row)return;
  const ep=row.dataset.epoch;$("#epochSel").value=ep;setEpoch(ep);
};
// Severity count chips: expose only the distribution, not the details.
function sevChips(sigs){
  const order={high:0,medium:1,low:2},cnt={};
  sigs.forEach(s=>{const k=s.severity||"low";cnt[k]=(cnt[k]||0)+1;});
  return Object.keys(cnt).sort((a,b)=>(order[a]??9)-(order[b]??9))
    .map(k=>'<span class="sev '+esc(k)+'">'+esc(k)+' '+cnt[k]+'</span>').join("");
}
function evText(ev){
  if(!ev||typeof ev!=="object")return"";
  const ks=Object.keys(ev).filter(k=>ev[k]!=null);
  if(!ks.length)return"";
  return ks.slice(0,4).map(k=>{let v=ev[k];
    if(Array.isArray(v))v=v.slice(0,3).map(x=>x&&typeof x==="object"?(x.function||x.step_id||JSON.stringify(x)):x).join(", ")+(ev[k].length>3?" …":"");
    else if(v&&typeof v==="object")v=JSON.stringify(v);
    return k+"="+v;}).join(" · ");
}
function fbHTML(d){
  const p=d.population||{},c=d.candidate||{},sigs=d.signals||[],dl=d.delta_vs_parent;
  // Profiling runs have no task results, and the backend flags them in feedback;
  // older snapshots lack that field, so fall back to the page's own detection.
  const prof=d.profiling===true||profilingOnly();
  const nn=v=>v==null?"—":v;
  // Without a price table cost is always 0, so show token usage instead of a misleading $0.
  const tkn=d.tokens||{},tokFmt=n=>n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"k":String(n||0);
  const noPrice=p.cost_usd===0&&!!tkn.total;
  const hasParent=!!c.parent_id;
  // Subtitle ids are 8 chars with the full value on hover: three raw uuids would flood the header;
  // the manual- prefix is the readable part, so keep it and truncate only the uuid after it.
  const short=v=>{const s=String(v);return /^manual-/.test(s)?s.slice(0,15):s.slice(0,8);};
  const sid=(v,t)=>v?'<span title="'+esc(t||v)+'">'+esc(short(v))+'</span>':"—";
  let h='<h3>'+tr("Optimization Feedback")+'</h3><div class="mtitle">epoch '+sid(d.epoch)+' · candidate '+sid(c.candidate_id)+' · parent '+sid(c.parent_id)+
    ' <button class="copybtn" data-linkparent="1" data-online>'+(hasParent?tr("Change link"):tr("Link parent"))+'</button>'+
    ' <button class="copybtn" data-fileexport="1" data-online title="'+tr("Write this round's signals/conclusion/feedback into the run directory for downstream RSI consumers")+'">'+tr("Export")+'</button></div>';
  // Verdict first: the verdict banner and next actions go before every metric.
  const cn=d.conclusion||{},vd=cn.verdict||{};
  const VLABEL={accept:tr("Accepted"),reject:tr("Rejected"),inconclusive:tr("Inconclusive")};
  const VCONF={high:tr("high"),medium:tr("medium"),low:tr("low")};
  if(prof){
    // Profiling runs have no task success rate, so the backend inconclusive verdict does not apply;
    // inference performance is also an RSI optimization target, so give metric-based actionable advice instead.
    h+='<div class="verdict"><span class="vd">profiling</span>'+
      '<span class="vr">'+tr("No task success verdict; gives optimization advice based on inference / hardware metrics")+'</span></div>';
  }else if(vd.decision){
    const rs=vd.reasons||[];
    h+='<div class="verdict '+esc(vd.decision)+'"><span class="vd">'+esc(VLABEL[vd.decision]||vd.decision)+'</span>'+
      '<span class="vr">'+esc(rs.length?rs[0].text:"")+'</span>'+
      '<span class="vconf hint" title="'+esc(cn.schema_version||"")+'">'+tr("confidence {v}",{v:esc(VCONF[vd.confidence]||vd.confidence||"—")})+'</span></div>';
    // Challenges beside the verdict come from LLM findings / deterministic signals; they warn but never change it.
    const chs=vd.challenges||[];
    if(chs.length){
      h+='<ul class="chal">'+chs.map(x=>'<li><span class="sev '+esc(x.severity||"low")+'">'+esc(x.severity||"low")+'</span><span>'+esc(x.text||"")+'</span></li>').join("")+'</ul>';
    }
  }
  // Profiling feedback centers on perf advice: the backend aggregates TTFT / ITL / throughput / cache / NPU / HBM per tier,
  // then emits metric-level actionable items; old snapshots without d.perf fall back to the rule diagnostics below.
  const perf=d.perf||{},padv=Array.isArray(perf.advice)?perf.advice:[];
  const perfData=(perf.tiers||[]).some(t=>t&&(t.ttft_p95!=null||t.throughput!=null||t.cache_hit!=null||t.npu_util!=null||t.hbm_usage!=null));
  if(prof&&padv.length){
    h+='<div style="margin-bottom:14px"><div class="sec-h">'+tr("Performance optimization advice")+'<span class="ssub">'+tr("based on this round's metrics")+'</span></div><ul class="actions">'+
      padv.map(a=>'<li><span class="sev '+esc(a.severity||"medium")+'">'+esc(a.severity||"medium")+'</span>'+
        '<div class="abody"><div class="aline"><b>'+esc(a.metric||"")+'</b><span>'+esc(a.action||"")+'</span></div>'+
        (a.value?'<div class="areason">'+tr("current value {v}",{v:esc(a.value)})+'</div>':'')+
        (a.reason?'<div class="areason">'+esc(a.reason)+'</div>':'')+
        '</div></li>').join("")+
      '</ul></div>';
  }else if(prof&&perfData){
    h+='<div class="cmpmeta"><div class="cmpwhy">'+tr("This round's inference / hardware metrics did not trigger any optimization rule; keep the current configuration.")+'</div></div>';
  }
  const acts=prof?[]:(cn.next_actions||[]);
  if(acts.length){
    h+='<div style="margin-bottom:14px"><div class="sec-h">'+tr("Next actions")+'</div><ul class="actions">'+
      acts.map(a=>'<li><span class="sev '+esc(a.priority||"low")+'">'+esc(a.priority||"low")+'</span>'+
        '<div class="abody"><div class="aline"><b>'+esc(a.target||"")+'</b><span>'+esc(a.action||"")+'</span></div>'+
        (a.reason?'<div class="areason">'+esc(a.reason)+'</div>':'')+'</div></li>').join("")+
      '</ul></div>';
  }
  // Manually compared runs have no optimizer-reported lineage, so let users link two epochs right here;
  // linked profiling runs compare per-tier performance metrics.
  const others=(EPOCHS||[]).filter(e=>e.epoch!==d.epoch);
  h+='<div class="linkrow" id="linkrow" hidden>'+
    (others.length?'<select id="parentPick">'+others.map(e=>'<option value="'+esc(e.epoch)+'">'+esc(String(e.epoch).slice(0,8))+' · '+esc(e.status||"—")+'</option>').join('')+'</select>':'<span class="hint">'+tr("No other epoch to link")+'</span>')+
    '<button data-dolink="1"'+(others.length?"":" disabled")+'>'+tr("Confirm")+'</button><button data-cancellink="1">'+tr("Cancel")+'</button>'+
    (hasParent?'<button data-unlink="1">'+tr("Unlink")+'</button>':"")+
    '<span class="hint">'+tr("Once linked, Delta vs parent is computed from the parent lineage")+'</span></div>';
  // Metrics area: profiling runs have no tasks/success/latency/steps, so show run type instead,
  // otherwise 0 tasks and 0 steps would be misread as real execution results.
  if(prof){
    // Prefer the backend tier list: local SUMMARIES may still be empty while SSE replay lags after an epoch switch.
    const concs=Array.isArray(d.profiling_concurrency)&&d.profiling_concurrency.length
      ?d.profiling_concurrency.slice().sort((a,b)=>a-b)
      :[...new Set([...SUMMARIES.values()].map(s=>(s.workload||{}).concurrency).filter(v=>v!=null))].sort((a,b)=>a-b);
    const concTxt=concs.length?concs.map(x=>"c"+x).join(" / "):"—";
    h+='<div class="cmpstrip"><span><em>'+tr("run type")+'</em>profiling</span>'+
      '<span><em>'+tr("tiers")+'</em>'+esc(concTxt)+'</span>'+
      '<span><em>'+tr("Agent steps")+'</em>'+tr("none")+'</span></div>';
    // Compare against the parent like normal runs, but on per-tier perf metrics rather than task success rate.
    const pa=perf.parent||null;
    if(pa&&Array.isArray(pa.tiers)&&pa.tiers.length){
      const fmtMs=v=>v==null?"—":dur(v);
      const fmtNum0=v=>v==null?"—":fmtNum(Math.round(v));
      const fmtPct=v=>v==null?"—":Number(v).toFixed(1)+"%";
      const fmtRate=v=>v==null?"—":(v*100).toFixed(1)+"%";
      // g: 1 means higher is better, -1 means lower is better; the Δ column is colored by direction.
      const defs=[
        ["ttft_p95","TTFT p95",fmtMs,-1],
        ["itl_mean","ITL mean",fmtMs,-1],
        ["throughput",tr("Total throughput (tok/s)"),fmtNum0,1],
        ["cache_hit",tr("cache hit rate"),fmtRate,1],
        ["npu_util",tr("NPU utilization"),fmtPct,1],
        ["hbm_usage",tr("HBM usage"),fmtPct,-1]];
      const tierKey=t=>t.concurrency!=null?"c"+t.concurrency:tr("single tier");
      // One row per tier per metric would flatten 6 metrics × N tiers into a long strip;
      // so use tier tabs that show one tier at a time and switch without refetching.
      const tiers=pa.tiers.filter(t=>t&&defs.some(([k])=>((t.current||{})[k]!=null)||((t.parent||{})[k]!=null)));
      if(tiers.length){
        const pe=String(pa.epoch||"");
        h+='<div class="sec-h" style="margin:14px 0 6px">'+tr("Compare with parent")+'<span class="ssub" title="'+esc(pe)+'">'+esc(pe.slice(0,8))+' · '+tr("by tier")+'</span></div>'+
          '<div class="ttabs" role="tablist">'+tiers.map((t,i)=>{
            const tl=tierKey(t);
            return '<button class="ttab'+(i?"":" on")+'" role="tab" aria-selected="'+(i?"false":"true")+
              '" data-ttab="'+esc(tl)+'">'+esc(tl)+'</button>';
          }).join('')+'</div>';
        h+=tiers.map((t,i)=>{
          const tl=tierKey(t);
          const rows=defs.map(([k,label,fmt,g])=>{
            const cur=(t.current||{})[k],prev=(t.parent||{})[k],dd=(t.delta||{})[k];
            if(cur==null&&prev==null)return null;
            const dt=!dd?"—":(dd.pct==null?(dd.abs>0?"+":"")+Number(dd.abs).toFixed(2):(dd.pct>0?"+":"")+Number(dd.pct).toFixed(1)+"%");
            const cls=(dd&&dd.pct!=null&&Math.abs(dd.pct)>0.5)?((dd.pct>0)===(g>0)?"dg":"db"):"";
            return {k:label,c:fmt(cur),p:fmt(prev),d:dt,cls};
          }).filter(Boolean);
          // A fixed 96px name column truncates long metric names, so hover shows the full name plus tier.
          return '<div class="mlist" data-tpane="'+esc(tl)+'"'+(i?" hidden":"")+'>'+
            rows.map(r=>'<div class="mrow"><span class="mk" title="'+esc(r.k+" · "+tl)+'">'+esc(r.k)+'</span>'+
              '<b class="mv">'+esc(r.c)+'</b><span class="md '+r.cls+'">'+esc(r.d)+'</span>'+
              '<span class="mp" title="'+tr("parent")+' '+esc(pe)+'">'+tr("parent")+' '+esc(r.p)+'</span></div>').join('')+
            '</div>';
        }).join('');
      }else{
        h+='<div class="cmpmeta"><div class="cmpwhy">'+esc(pa.note||tr("The parent has no comparable performance metrics"))+'</div></div>';
      }
    }else if(pa){
      h+='<div class="cmpmeta"><div class="cmpwhy">'+esc(pa.note||tr("The parent is not a profiling run, so there are no inference / hardware metrics to compare"))+'</div></div>';
    }else{
      h+='<div class="cmpmeta"><div class="cmpwhy">'+tr("No parent to compare against; this round is recorded as the performance baseline.")+'</div></div>';
    }
    h+='<div class="cmpmeta"><div class="cmpwhy">'+tr("This run only performs inference / hardware profiling and has no agent trace or task results; success rate, P50/P95, tokens and steps do not apply. See the Metrics tab for metrics.")+'</div>'+
      '<div class="cmpchips" style="margin-top:8px"><button class="copybtn" data-gomet="1">'+tr("View Metrics")+'</button></div></div>';
  }else{
    // Metrics area: the three-column table carries the deltas, and the Δ column is colored better/worse.
    const dv=dl?(dl.values||{}):null, cval=dv?dv.current||{}:{}, pval=dv?dv.parent||{}:{};
    const pct=v=>v==null?"—":(v*100).toFixed(1)+"%";
    const num1=v=>v==null?"—":String(Math.round(v*10)/10);
    const money=v=>v==null?"—":(Math.abs(v)<1e-9?"$0.0000":(v>0?"+":"-")+"$"+Math.abs(Number(v)).toFixed(4));
    const money0=v=>v==null?"—":"$"+Number(v).toFixed(4);
    const sgn=(v,u,n)=>v==null?"—":Math.abs(v)<1e-9?"0"+u:(v>0?"+":"")+Number(v).toFixed(n)+u;
    // g: 1 means higher is better, -1 means lower is better, 0 means no coloring.
    const rows=[
      {k:tr("Success rate"),key:"success_rate",c:pct(p.success_rate),p:dl?pct(pval.success_rate):"—",
       d:dl?sgn(dl.success_rate*100,"pp",1):"—",raw:dl?dl.success_rate:null,g:1},
      {k:"tasks",key:"tasks",c:nn(p.tasks),p:dl?nn((dl.samples||{}).parent):"—",
       d:dl&&(dl.samples||{}).parent!=null?(()=>{const n=(p.tasks||0)-(dl.samples.parent||0);return n>0?"+"+n:String(n);})():"—",raw:null,g:0},
      {k:"P50",key:"p50_latency_ms",c:dur(p.p50_latency_ms),p:dl?dur(pval.p50_latency_ms):"—",
       d:dl?dur(dl.p50_latency_ms,true):"—",raw:dl?dl.p50_latency_ms:null,g:-1},
      {k:"P95",key:"p95_latency_ms",c:dur(p.p95_latency_ms),p:dl?dur(pval.p95_latency_ms):"—",
       d:dl?dur(dl.p95_latency_ms,true):"—",raw:dl?dl.p95_latency_ms:null,g:-1}];
    if(noPrice){
      rows.push({k:"tokens",key:"tokens",c:tokFmt(tkn.total),p:"—",d:"—",raw:null,g:0});
    }else{
      rows.push({k:"Cost / task",key:"cost_usd",c:dl?money0(cval.cost_per_task):(p.cost_usd!=null?"$"+p.cost_usd+" "+tr("total"):"—"),
        p:dl?money0(pval.cost_per_task):"—",d:dl?money(dl.cost_per_task):"—",
        raw:dl?dl.cost_per_task:null,g:-1});
    }
    rows.push({k:"steps / traj",key:"steps_mean",c:num1(p.steps_mean),p:dl?num1(pval.steps_mean):"—",
      d:dl?sgn(dl.steps_mean,"",2):"—",raw:null,g:0});
    // Metric comparison: one row per metric (name / current / Δ / parent) with wrapping in narrow columns;
    // cards grow 90px per metric and would balloon once inference and hardware metrics land, while rows add only 30px.
    if(dl){
      h+='<div class="mlist">'+rows.map(r=>{
          const cls=(r.raw!=null&&r.g&&Math.abs(r.raw)>1e-9)?((r.raw>0)===(r.g>0)?"dg":"db"):"";
          return '<div class="mrow" data-metric="'+esc(r.key)+'"><span class="mk">'+esc(r.k)+'</span>'+
            '<b class="mv">'+esc(r.c)+'</b>'+
            '<span class="md '+cls+'">'+esc(r.d)+'</span>'+
            '<span class="mp">'+tr("parent")+' '+esc(r.p)+'</span></div>';
        }).join("")+'</div>';
    }else{
      h+='<div class="cmpstrip">'+rows.map(r=>'<span data-metric="'+esc(r.key)+'"><em>'+esc(r.k)+'</em>'+esc(r.c)+'</span>').join('')+'</div>';
    }
    // Fold the old Delta block's notes under the table: status chips on line one, plain-language explanation on line two.
    h+='<div class="cmpmeta">';
    if(dl){
      const at=dl.attribution||{},dci=(dl.success_rate_ci||{}).diff,sm=dl.samples||{};
      h+='<div class="cmpchips"><span class="stchip">'+esc(dl.significant?tr("significant change"):tr("no significant change"))+'</span>'+
        '<span class="hint" title="'+esc(dl.parent_epoch||"")+'">vs '+esc(String(dl.parent_epoch||"—").slice(0,8))+'</span>'+
        '<span class="hint" title="'+esc(at.keys?at.keys.join(", "):"")+'">'+tr("attribution")+' '+esc(at.changed||tr("unknown"))+(at.keys&&at.keys.length?" ("+esc(at.keys.join(", "))+")":"")+'</span></div>';
      // Interval numbers stay in the API and artifacts; the panel explains in plain words whether a conclusion can be drawn.
      let why="";
      if(dci){
        const cross=dci[0]<=0&&dci[1]>=0;
        const small=(sm.current||0)<MIN_TASKS||(sm.parent||0)<MIN_TASKS;
        why=cross?tr("The success-rate change could still be real or sampling noise")
          :(dci[0]>0?tr("The success-rate gain exceeds sampling noise, so it is likely a real improvement"):tr("The success-rate drop exceeds sampling noise, so it is likely a real regression"));
        if(small)why+=tr(" (this round {cur} / parent {parent} tasks; the sample is small, for reference only)",{cur:nn(sm.current),parent:nn(sm.parent)});
      }
      // The attribution note and the significance explanation are one layer of information; merge them so the two lines don't each tell half.
      if(at.note)why+=(why?tr("; "):"")+at.note;
      if(why)h+='<div class="cmpwhy">'+esc(why)+'</div>';
    }else{
      h+='<div class="cmpwhy">'+(d.explain?esc(d.explain):tr("No parent to compare against; this round is recorded as the baseline"))+'</div>';
    }
    h+='</div>';
  }
  // Top spans are the drill-down for metrics; profiling runs have no agent steps, so skip the whole block.
  if(!prof){
    const spans=p.top_spans||[];
    h+='<details class="sigbox"><summary>'+tr("Duration breakdown")+'<span class="ssub">'+tr("by call name ({n})",{n:spans.length})+'</span></summary>';
    if(!spans.length){
      h+='<div class="empty" style="padding:16px">'+tr("No duration data")+'</div>';
    }else{
      h+='<div style="padding:10px 0 4px">';
      spans.forEach(s=>{h+='<div class="bar-row"><div class="bl">'+esc(s.function)+'</div><div class="bt"><div class="bf" style="width:'+Math.min(100,s.share_pct||0)+'%;background:#58a6ff"></div></div><div class="bv">'+(s.share_pct||0).toFixed(1)+'%</div></div>';});
      h+='</div>';
    }
    h+='</details>';
  }
  // Rule diagnostics: show only severity chips by default and expand details on demand; auto-expand when the LLM is unavailable.
  // Kept for profiling runs too: perf advice is the converged conclusion, while matched rules are the drill-down evidence.
  {
    const llmFailed=!(d.analysis&&d.analysis.source==="llm");
    h+='<details class="sigbox"'+(llmFailed?" open":"")+'><summary>'+tr("Rule diagnostics")+
      (llmFailed?'<span class="ssub">'+tr("LLM unavailable; expanded the fallback")+'</span>':'')+
      '<span class="sumr">'+sevChips(sigs)+'</span></summary>';
    if(!sigs.length)h+='<div class="empty" style="padding:16px">'+tr("No rule matched this round")+'</div>';
    sigs.forEach(s=>{h+='<div class="fnd"><span class="sev '+esc(s.severity||"low")+'">'+esc(s.severity||"low")+'</span> <span class="kv" style="display:inline">'+esc(s.target||"")+' / '+esc(s.category||"")+'</span><div class="t">'+esc(s.title||"")+'</div>'+(s.detail?'<div class="kv">'+esc(s.detail)+'</div>':'')+(s.suggestion&&s.suggestion.direction?'<div class="kv">→ '+esc(s.suggestion.direction)+'</div>':'')+sigEvHTML(s.evidence)+'</div>';});
    h+='</details>';
  }
  // LLM analysis: collapsed by default like the other two sections; long text should not steal focus from the verdict.
  const an=d.analysis||{};
  h+='<details class="sigbox"><summary>'+tr("LLM analysis")+'<span class="ssub"'+((an.source==="llm"&&an.model)?' title="'+esc(an.model)+'"':'')+'>'+(an.source==="llm"?esc(trunc(String(an.model||"—").split("/").pop())):tr("rule fallback"))+'</span>'+
    // Keep it clickable even without a provider: the backend returns a clear error, which is easier to diagnose than a greyed-out button
    '<button class="copybtn" data-rerun="1" data-online style="margin-left:auto" title="'+
      ((d.llm&&d.llm.configured)?tr("Re-run LLM analysis"):tr("No LLM provider configured (TRACER_LLM_API_KEY or MODEL_API_KEY required)"))+'">'+tr("Re-analyze")+'</button></summary>';
  if(an.source==="llm"){
    h+='<div class="kv">'+esc(an.summary||"")+(an.dropped_findings?'<span style="opacity:.6">'+tr("({n} findings with unsupported evidence dropped)",{n:an.dropped_findings})+'</span>':'')+'</div>';
    (an.findings||[]).forEach(f=>{h+='<div class="fnd"><span class="sev '+esc(f.severity||"low")+'">'+esc(f.severity||"low")+'</span> <span class="kv" style="display:inline">'+esc(f.category||"")+'</span><div class="t">'+esc(f.title||"")+'</div>'+(f.detail?'<div class="kv">'+esc(f.detail)+'</div>':'')+(f.recommendation?'<div class="kv">→ '+esc(f.recommendation)+'</div>':'')+fbEvHTML(f.evidence)+'</div>';});
  }else{
    const err=an.llm_error||null;
    h+='<div class="kv" style="'+(err?'color:#f85149':'opacity:.7')+'">'+(err?tr("LLM call failed: {msg}",{msg:esc(err)}):tr("No LLM analysis for this epoch yet (no provider configured, or analysis not triggered)"))+'</div>';
  }
  h+='</details>';
  // Artifact paths go after all collapsible sections so they stay visible when collapsed and don't break the rhythm of the three blocks above.
  const art=d.artifacts||{};
  const saved=[["conclusion.json",art.conclusion_json],["conclusion.md",art.conclusion_md],
               ["signals.json",art.signals_json],["signals.md",art.signals_md]].filter(x=>x[1]);
  if(saved.length){
    // The evaluator saves these files when the run finishes; show only the paths here, no export button.
    const rel=p=>{const rd=art.run_dir;const s=String(p);return rd&&s.indexOf(rd)===0?s.slice(rd.length).replace(/^[\\/]+/,""):s;};
    const copyPath=(art.conclusion_json||art.signals_json);
    h+='<div class="hint" style="margin:2px 0 10px">'+tr("Saved automatically")+' · '+
      saved.map(x=>'<code>'+esc(rel(x[1]))+'</code>').join(' · ')+
      ' <button class="copybtn" data-copysig="'+esc(copyPath)+'" title="'+esc(copyPath)+'">'+tr("Copy path")+'</button></div>';
  }else{
    // Older runs have no recorded paths (they finished before this feature), so say so instead of hiding it silently.
    h+='<div class="hint" style="margin:2px 0 10px">'+tr("Artifact paths were not recorded (the run predates this feature, or the plugin was not loaded)")+'</div>';
  }
  return h;
}
async function loadFeedback(){
  // Snapshot mode: setTab("fb") also lands here, so render inline data directly without a request.
  if(SNAP){document.getElementById("fbpane").innerHTML=fbHTML(SNAP.feedback||{});return;}
  if(!CUR_EPOCH){loadOverview();return;}
  const box=document.getElementById("fbpane");
  box.innerHTML='<div class="empty"><span class="spin"></span>'+tr("Loading feedback…")+'</div>';
  try{
    const q="?epoch="+encodeURIComponent(CUR_EPOCH);
    const r=await fetch(apiUrl("/v1/feedback"+q));
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||("HTTP "+r.status));
    CUR_EPOCH=d.epoch||CUR_EPOCH;
    box.innerHTML=fbHTML(d);
  }catch(e){box.innerHTML=emptyHTML(tr("Failed to load feedback"),esc(e.message),"error");}
}
// Add or change the parent edge manually: the API generates manual-<short id> when candidate_id is missing.
async function linkEpoch(parentEpoch){
  const ep=CUR_EPOCH;if(!ep)return;
  try{
    const r=await fetch(apiUrl("/v1/runs/"+encodeURIComponent(ep)+"/link"),{method:"POST",
      headers:{"content-type":"application/json"},body:JSON.stringify({parent_epoch:parentEpoch})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||("HTTP "+r.status));
    toast(parentEpoch?tr("Parent linked"):tr("Parent link removed"));
    loadEpochs();loadFeedback();
  }catch(err){toast(tr("Link failed: {msg}",{msg:err.message}));}
}
// Rerun LLM analysis: force a recompute bypassing the cache (retry is allowed for epochs that failed).
document.getElementById("fbpane").addEventListener("click",async e=>{
  if(e.target.closest("button[data-gomet]")){setTab("met");return;}
  // Evidence navigation for LLM findings: step → trajectory waterfall, session → its trajectory, metric → metric row.
  const ls=e.target.closest("button[data-loc-step]");
  if(ls){locateStep(ls.dataset.locStep);return;}
  const lss=e.target.closest("button[data-loc-session]");
  if(lss){locateSession(lss.dataset.locSession);return;}
  const lm=e.target.closest("button[data-loc-metric]");
  if(lm){locateMetric(lm.dataset.locMetric);return;}
  // Tier tabs only switch the view, no refetch: all tiers are already rendered, avoiding a full-page flicker.
  const tt=e.target.closest("button[data-ttab]");
  if(tt){
    const bar=tt.closest(".ttabs"),pick=tt.dataset.ttab;
    bar.querySelectorAll("button[data-ttab]").forEach(b=>{
      const on=b===tt;b.classList.toggle("on",on);b.setAttribute("aria-selected",on?"true":"false");});
    for(let n=bar.nextElementSibling;n&&n.hasAttribute("data-tpane");n=n.nextElementSibling){
      n.hidden=n.getAttribute("data-tpane")!==pick;
    }
    return;
  }
  if(e.target.closest("button[data-linkparent]")){
    const row=document.getElementById("linkrow");if(row)row.hidden=!row.hidden;return;}
  if(e.target.closest("button[data-fileexport]")){await exportFiles();return;}
  if(e.target.closest("button[data-cancellink]")){
    const row=document.getElementById("linkrow");if(row)row.hidden=true;return;}
  if(e.target.closest("button[data-dolink]")){
    const sel=document.getElementById("parentPick"),pe=sel&&sel.value;
    if(!pe){toast(tr("No epoch available to link"));return;}
    await linkEpoch(pe);return;}
  if(e.target.closest("button[data-unlink]")){await linkEpoch(null);return;}
  const cp=e.target.closest("button[data-copysig]");
  if(cp){navigator.clipboard.writeText(cp.dataset.copysig||"").then(()=>toast(tr("Path copied")),()=>toast(tr("Copy failed")));return;}
  const b=e.target.closest("button[data-rerun]");
  if(!b||b.disabled)return;
  // The button sits inside <summary>, so prevent default to avoid collapsing the panel when clicking it.
  e.preventDefault();e.stopPropagation();
  const ep=CUR_EPOCH;if(!ep)return;
  b.disabled=true;const old=b.textContent;b.textContent=tr("Analyzing…");
  try{
    const r=await fetch(apiUrl("/v1/feedback/rerun?epoch="+encodeURIComponent(ep)),{method:"POST"});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||("HTTP "+r.status));
    toast(tr("LLM analysis updated"));loadFeedback();return;
  }catch(err){toast(tr("Analysis failed: {msg}",{msg:err.message}));}
  b.disabled=false;b.textContent=old;
});
