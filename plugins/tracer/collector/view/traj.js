const NAMES=document.getElementById("namesBody"),TRACKS=document.getElementById("tracksBody");
let syncLock=false;
NAMES.addEventListener("scroll",()=>{if(syncLock)return;syncLock=true;TRACKS.scrollTop=NAMES.scrollTop;syncLock=false;});
TRACKS.addEventListener("scroll",()=>{if(syncLock)return;syncLock=true;NAMES.scrollTop=TRACKS.scrollTop;syncLock=false;});
function makeDrag(el,fn){el.addEventListener("mousedown",e=>{e.preventDefault();document.body.style.userSelect="none";const mv=ev=>fn(ev.clientX);const up=()=>{document.removeEventListener("mousemove",mv);document.removeEventListener("mouseup",up);document.body.style.userSelect="";persistVars();};document.addEventListener("mousemove",mv);document.addEventListener("mouseup",up);});}
// Column width memory: resetting on refresh would waste the drag, so persist in localStorage
const WIDTH_VARS=["--navw","--namew","--detw"];
function persistVars(){try{WIDTH_VARS.forEach(v=>{const val=document.documentElement.style.getPropertyValue(v);if(val)localStorage.setItem("tracer:"+v,val);});}catch(e){}}
function restoreVars(){try{WIDTH_VARS.forEach(v=>{const val=localStorage.getItem("tracer:"+v);if(val)document.documentElement.style.setProperty(v,val);});}catch(e){}}
makeDrag(document.getElementById("splitRail"),x=>{const r=document.getElementById("trajrail").getBoundingClientRect();document.documentElement.style.setProperty("--navw",Math.max(150,Math.min(window.innerWidth*.4,x-r.left))+"px");});
makeDrag(document.getElementById("splitName"),x=>{const r=document.getElementById("wfNames").getBoundingClientRect();document.documentElement.style.setProperty("--namew",Math.max(120,Math.min(window.innerWidth*.6,x-r.left))+"px");});
makeDrag(document.getElementById("splitDet"),x=>{document.documentElement.style.setProperty("--detw",Math.max(240,Math.min(window.innerWidth*.7,window.innerWidth-x))+"px");});
function flameRows(mode){
  // Aggregate view: merge by function name (llm.call / bash / user.input) to answer "who takes the most time"
  if(mode==="agg")return aggRows();
  // Expanded view: one row per call instance, indented by ancestry depth
  const tree=ancestryTree(),out=[];
  const w=(n,d)=>{const o=n.occ||[];
    if(!o.length)return;              // nodes without real steps take no row
    o.forEach(st=>{const so=T.get(st);if(!so)return;
      out.push({depth:d,kind:st.source||"agent",label:n.name,s:so.s,
        e:so.inst||so.synth?so.s:so.e,inst:!!(so.inst||so.synth),occ:[st]});});
    n.children.forEach(c=>w(c,d+1));};
  tree.roots.forEach(r=>w(r,0));
  return out;
}
// Merge all calls of one function name into a row: count, cumulative time, active range
function aggRows(){
  const g=new Map();
  STEPS.forEach(st=>{const t=T.get(st);if(!t)return;
    const a=(st.extra&&st.extra.ancestry)||{};
    const nm=a.function_name||st.source||"step";
    let o=g.get(nm);
    if(!o){o={name:nm,kind:st.source||"agent",count:0,occ:[],busy:0,s:Infinity,e:-Infinity,real:false};g.set(nm,o);}
    o.count++;o.occ.push(st);
    // Steps without real timestamps are excluded from the total, or the synthetic 0.6s counts as cost
    if(!t.synth)o.busy+=Math.max(0,t.e-t.s);
    o.s=Math.min(o.s,t.s);o.e=Math.max(o.e,t.e);
    if(!(t.inst||t.synth))o.real=true;});
  return [...g.values()].sort((a,b)=>b.busy-a.busy).map(o=>({
    depth:0,kind:o.kind,label:o.name,count:o.count,
    s:isFinite(o.s)?o.s:0,e:isFinite(o.e)?o.e:(isFinite(o.s)?o.s:0),
    inst:!o.real,agg:o.count>1,busy:o.busy,occ:o.occ}));
}
function ancestryTree(){
  const nodes=new Map();
  const get=(id,name)=>{if(!nodes.has(id))nodes.set(id,{id,name:name||id,parent:null,children:[],occ:[]});return nodes.get(id);};
  const implicit=new Map();
  // parent_id stores a step number (s49) but node keys are function_id (f49); map first or ghost nodes appear
  const fnOfStep=new Map();
  STEPS.forEach(st=>{const a=(st.extra&&st.extra.ancestry)||{};if(a.function_id)fnOfStep.set(st.step_id,a.function_id);});
  STEPS.forEach(st=>{const a=(st.extra&&st.extra.ancestry)||{};if(!a.function_id)return;
    subsOf(st).forEach(sub=>(sub.steps||[]).forEach(ss=>{const sa=(ss.extra&&ss.extra.ancestry)||{};if(!sa.parent_id&&sa.function_id)implicit.set(sa.function_id,a.function_id);}));});
  STEPS.forEach(st=>{const a=(st.extra&&st.extra.ancestry)||{function_id:"src:"+(st.source||"agent"),function_name:st.source||"agent"};const n=get(a.function_id,a.function_name);n.occ.push(st);
    const rawPid=a.parent_id;
    const pid=rawPid==null?implicit.get(a.function_id):(fnOfStep.get(rawPid)||rawPid);
    if(pid){const p=get(pid,a.parent_name);if(!p.children.includes(n))p.children.push(n);n.parent=p.id;}});
  return{nodes,roots:[...nodes.values()].filter(n=>!n.parent)};
}
function details(r){
  const st=r.step||(r.occ&&r.occ[0]);const out=[];
  // Record and highlight the selected row so the bar clicked in the waterfall is obvious
  SEL_KEY=rowKey(r);
  document.querySelectorAll(".wf-row.sel").forEach(el=>el.classList.remove("sel"));
  document.querySelectorAll('.wf-row[data-key="'+SEL_KEY+'"]').forEach(el=>el.classList.add("sel"));
  const idx=CUR_ROWS.findIndex(x=>rowKey(x)===SEL_KEY);
  const sec=(h,body,forceFold,meta,cls)=>{
    const html=String(body==null?"":body),fold=forceFold||html.length>900;
    out.push(`<section><h4>${h}${meta?`<span class="meta">${esc(meta)}</span>`:""}<button class="copybtn" data-cp="1">${tr("Copy")}</button></h4><pre class="${(cls||"")+(fold?" fold":"")}">${html}</pre>`+
      (fold?`<button class="copybtn expandbtn" data-exp="1">${tr("Show full text")}</button>`:"")+`</section>`);
  };
  CUR_ROW=r;CUR_STEP=st||null;
  // Synthetic row: the system prompt has no times of its own, but it is the trace's first input, so it gets its own row
  if(r.sysPrompt){
    out.push(`<div class="dnav"><button data-nav="-1"${idx<=0?" disabled":""}>↑ ${tr("Prev")}</button><button data-nav="1"${(idx<0||idx>=CUR_ROWS.length-1)?" disabled":""}>↓ ${tr("Next")}</button>`+(idx<0?"":`<span class="hint">${idx+1} / ${CUR_ROWS.length}</span>`)+`</div>`);
    out.push(`<div class="dhead"><b>system prompt</b> <span class="badge">${tr("trajectory-level input")}</span></div>`);
    out.push(`<div class="note">${tr("One system prompt shared by the whole trajectory; it does not belong to any single call.")}</div>`);
    sec("System prompt", esc(r.sysPrompt), false);
    $("#details").innerHTML=out.join("");
    if(window.innerWidth<=820&&window.__openDet)window.__openDet();
    return;
  }
  out.push(`<div class="dnav"><button data-nav="-1"${idx<=0?" disabled":""}>↑ ${tr("Prev")}</button><button data-nav="1"${(idx<0||idx>=CUR_ROWS.length-1)?" disabled":""}>↓ ${tr("Next")}</button>`+(idx<0?"":`<span class="hint">${idx+1} / ${CUR_ROWS.length}</span>`)+`</div>`);
  out.push(`<div class="dhead"><b>${esc(r.label)}</b> <span class="badge">${esc(r.cat?r.cat.t:(r.subagent?"subagent":r.kind))}</span>${rowErr(r)?' <span class="sev high">failed</span>':""}<button class="copybtn" data-cpstep="1">${tr("Copy JSON")}</button></div>`);
  const idxNow=CUR_ROWS.findIndex(x=>rowKey(x)===SEL_KEY);
  // Header facts collapse into a two-column grid with dim labels and bright values; the old "·"-joined sentences read like prose
  const totalDur=(T1-T0)||1,frows=[];
  const oo=st?T.get(st):null,instant=!!(oo&&(oo.inst||oo.synth));
  const timeStr=instant?tr("{t}s · instant event",{t:(r.s-DATA0).toFixed(2)})
    :tr("{from}s → {to}s ({dur}s)",{from:(r.s-DATA0).toFixed(2),to:(r.e-DATA0).toFixed(2),dur:(r.e-r.s).toFixed(2)});
  if(st){
    frows.push([tr("Step"),`#${esc(stepNo(st.step_id))} · ${esc(st.source)}`]);
    if(st.model_name)frows.push([tr("Model"),esc(st.model_name)]);
  }
  frows.push([tr("Time"),timeStr]);
  if(!r.inst)frows.push([tr("Share"),((r.e-r.s)/totalDur*100).toFixed(1)+"%"]);
  if(idxNow>0){const pv=CUR_ROWS[idxNow-1],pe=(pv.e==null?pv.s:pv.e),gap=r.s-pe;
    if(isFinite(gap)&&gap>0.005)frows.push([tr("Since prev"),gap.toFixed(2)+"s"]);}
  if(r.count)frows.push([tr("Calls"),tr("{n} calls",{n:r.count})+(r.busy!=null?tr(" · cumulative {busy}s",{busy:r.busy.toFixed(2)}):"")]);
  out.push('<div class="fgrid">'+frows.map(([k,v])=>`<b>${k}</b><span>${v}</span>`).join("")+'</div>');
  if(!st){$("#details").innerHTML=out.join("");return;}
  // Raw failure reason: status only says it failed, error says why
  const inv0=(st.extra&&st.extra.invocation)||{},errTxt=inv0.error||st.error||null;
  if(errTxt)out.push('<section><h4>Error</h4><pre style="border-color:#f8514966;color:#ffb3b3">'+esc(typeof errTxt==="string"?errTxt:fmt(errTxt))+"</pre></section>");
  if(st.reasoning_content){
    const rl=st.reasoning_content.length>900;
    out.push(`<section><h4>Reasoning <button class="copybtn" data-cp="1">${tr("Copy")}</button></h4><div class="msg md${rl?" fold":""}">${mdHTML(st.reasoning_content)}</div>`+
      (rl?`<button class="copybtn expandbtn" data-exp="1">${tr("Show full text")}</button>`:"")+`</section>`);
  }
  // Messages are usually markdown: render code blocks, bold and inline code; long text folds by default
  const rawMsg=typeof st.message==="string"?st.message:JSON.stringify(st.message||"");
  const msgLong=rawMsg.length>900;
  if(rawMsg.trim())out.push(`<section><h4>Message <button class="copybtn" data-cp="1">${tr("Copy")}</button></h4><div class="msg md${msgLong?" fold":""}">${mdHTML(st.message)}</div>`+
    (msgLong?`<button class="copybtn expandbtn" data-exp="1">${tr("Show full text")}</button>`:"")+`</section>`);
  // On tool-call turns the model returns only the reasoning block + toolCall, so the body is empty by design: say so, no blank box
  else if(st.source==="agent")out.push(`<section><h4>Message</h4><div class="note">${tr("No text output this turn: the model only returned reasoning and tool calls.")}</div></section>`);
  if(r.tool!=null){const tc=st.tool_calls[r.tool];
    out.push(`<section><h4>Tool call · ${esc(tc.function_name)} <button class="copybtn" data-cp="1">${tr("Copy")}</button></h4>${toolArgsHTML(tc.function_name,tc.arguments,false)}</section>`);}
  else if(st.tool_calls&&st.tool_calls.length){
    out.push(`<section><h4>Tool calls · ${st.tool_calls.length} <button class="copybtn" data-cp="1">${tr("Copy")}</button></h4>`+
      st.tool_calls.map(t=>toolArgsHTML(t.function_name,t.arguments)).join("")+`</section>`);}
  if(st.observation)sec("Observation",obsHTML(st.observation),false,obsMeta(st.observation),"out");
  if(st.metrics)out.push(`<section><h4>Metrics</h4>${metricsHTML(st.metrics)}</section>`);
  // Ancestry is two or three metadata fields; one line reads better than a whole JSON block
  if(st.extra&&st.extra.ancestry){const a=st.extra.ancestry;
    out.push(`<div class="ancestry">${tr("owner")} <b>${esc(a.function_name||"—")}</b>`+
      (a.parent_id?` · ${tr("upstream")} <b>${esc(a.parent_id)}</b>`:"")+
      (a.agent?" · agent <b>"+esc(typeof a.agent==="string"?a.agent:(a.agent.name||""))+"</b>":"")+`</div>`);}
  $("#details").innerHTML=out.join("");
  // On small screens details live in a drawer: slide it out on selection, or clicks seem to do nothing
  if(window.innerWidth<=820&&window.__openDet)window.__openDet();
}
// Tool output is raw text: JSON.stringify would squash newlines into \n and read as a blob of escapes.
// Render text first here; fall back to JSON only for structured data.
function obsHTML(obs){
  if(typeof obs.content==="string"&&obs.content.trim())return esc(obs.content);
  if(Array.isArray(obs.results)&&obs.results.length){
    return obs.results.map(r=>{
      const t=r&&(r.content!=null?r.content:(r.text!=null?r.text:r.output));
      return esc(t!=null?(typeof t==="string"?t:fmt(t)):fmt(r));
    }).join("\n\n");
  }
  return esc(fmt(obs));
}
// What matters in tool arguments is the content: flatten {command: "..."} into text instead of letting the
// JSON scaffolding and escaped newlines squeeze it together. Only multi-argument calls degrade to key = value lines.
// The $ prompt belongs to shell-like tools only — read_file / search / MCP tools must not show it.
function isShellTool(name){return /^(bash|sh|zsh|shell|terminal|exec|exec_command|run_command|command|cmd|powershell)$/i.test(name||"");}
function toolArgsHTML(name,args,showName){
  let a=args;
  if(typeof a==="string"){const s=a.trim();
    if(s.startsWith("{")||s.startsWith("[")){try{a=JSON.parse(s)}catch(e){a=s}}else a=s;}
  const head=(showName!==false&&name)?'<div class="toolname">'+esc(name)+'</div>':"";
  const shell=isShellTool(name);
  let txt=null,prompt="",extra="";
  if(typeof a==="string"){txt=a;if(shell)prompt="<i>$</i>";}
  else if(a&&typeof a==="object"){
    const ks=Object.keys(a);
    // The command is a shell tool's main argument and stays verbatim; execution limits like timeout are noted below the block
    if(shell){
      const pk=ks.find(k=>typeof a[k]==="string"&&/^(command|cmd|script|code|input|shell|args)$/i.test(k))
        ||ks.find(k=>typeof a[k]==="string");
      if(pk){
        txt=a[pk];prompt="<i>$</i>";
        const rest=ks.filter(k=>k!==pk);
        if(rest.length)extra='<div class="cmdmeta">'+rest.map(k=>esc(k)+" "+esc(typeof a[k]==="string"?a[k]:JSON.stringify(a[k]))).join(" · ")+'</div>';
      }else txt=ks.map(k=>k+" = "+(typeof a[k]==="string"?a[k]:JSON.stringify(a[k]))).join("\n");
    }
    else txt=ks.map(k=>k+" = "+(typeof a[k]==="string"?a[k]:JSON.stringify(a[k]))).join("\n");
  }else txt=fmt(a);
  const fold=txt.length>900;
  return head+'<pre class="cmd'+(fold?" fold":"")+'">'+prompt+esc(txt)+'</pre>'+extra+
    (fold?'<button class="copybtn expandbtn" data-exp="1">'+tr("Show full text")+'</button>':"");
}
// Output blocks show line count and size, so long logs are easy to triage at a glance
function obsMeta(obs){
  let t="";
  if(typeof obs.content==="string")t=obs.content;
  else if(Array.isArray(obs.results))t=obs.results.map(r=>(r&&(r.content!=null?r.content:r.text))||"").join("\n");
  if(!t)return"";
  return tr("{n} lines · {size} chars",{n:t.split("\n").length,size:t.length>=1000?(t.length/1000).toFixed(1)+"k":t.length});
}
// Metrics have few fields; a two-column key/value layout saves half the height of a JSON block
function metricsHTML(m){
  const ks=Object.keys(m||{});
  if(!ks.length)return'<div class="kv">—</div>';
  return '<div class="mgrid">'+ks.map(k=>{
    const v=m[k];
    return '<b>'+esc(k)+'</b><span>'+esc(v&&typeof v==="object"?fmt(v):String(v))+'</span>';
  }).join("")+'</div>';
}
// Same for inline previews: keep the command text, hide the {"command": ...} wrapper
function argPreview(args){
  let a=args;
  if(typeof a==="string"){const s=a.trim();
    if(s.startsWith("{")||s.startsWith("[")){try{a=JSON.parse(s)}catch(e){return trunc(s)}}else return trunc(s);}
  if(a&&typeof a==="object"){
    const ks=Object.keys(a);
    // If a primary argument such as command or path exists show only it; the rest (timeout etc.) stay out of the inline preview
    const pk=ks.find(k=>typeof a[k]==="string"&&/^(command|cmd|script|code|input|path|file|query|pattern|url)$/i.test(k))
      ||ks.find(k=>typeof a[k]==="string");
    if(pk)return trunc(a[pk]);
  }
  return trunc(fmt(a));
}
// Move between steps, shared by the detail-pane buttons and the ↑/↓ keys
function navStep(dir){
  const list=CUR_ROWS;if(!list.length)return;
  let i=list.findIndex(x=>rowKey(x)===SEL_KEY);
  if(i<0)i=dir>0?-1:list.length;
  const j=i+dir;if(j<0||j>=list.length)return;
  details(list[j]);
  const el=document.querySelector('#namesBody .wf-row[data-key="'+SEL_KEY+'"]');
  if(el)el.scrollIntoView({block:"nearest"});
}
$("#details").addEventListener("click",e=>{
  const nav=e.target.closest("button[data-nav]");
  if(nav){navStep(+nav.dataset.nav);return;}
  // Long-text folding: expanding removes fold and hides the button
  const ex=e.target.closest("button[data-exp]");
  if(ex){const sec=ex.closest("section");const box=sec&&sec.querySelector("pre.fold,.msg.fold");
    if(box)box.classList.remove("fold");ex.style.display="none";return;}
  const js=e.target.closest("button[data-cpstep]");
  if(js){const txt=JSON.stringify({step:CUR_STEP,timing:CUR_ROW?{s:CUR_ROW.s,e:CUR_ROW.e,inst:!!CUR_ROW.inst}:null},null,2);
    navigator.clipboard.writeText(txt).then(()=>{js.textContent=tr("Copied");setTimeout(()=>{js.textContent=tr("Copy JSON");},1200);})
      .catch(()=>{js.textContent=tr("Copy failed");setTimeout(()=>{js.textContent=tr("Copy JSON");},1200);});return;}
  const b=e.target.closest("button[data-cp]");if(!b)return;
  const pre=b.closest("section").querySelector("pre,.msg");if(!pre)return;
  navigator.clipboard.writeText(pre.textContent).then(()=>{
    b.textContent=tr("Copied");setTimeout(()=>{b.textContent=tr("Copy");},1200);
  }).catch(()=>{b.textContent=tr("Copy failed");setTimeout(()=>{b.textContent=tr("Copy");},1200);});
});
function setView(v){VIEW=v;document.querySelectorAll(".viewbtn").forEach(b=>b.classList.toggle("on",b.dataset.v===v));render();}
document.getElementById("views").onclick=e=>{const b=e.target.closest(".viewbtn");if(b)setView(b.dataset.v);};
function clampView(){const dmin=DATA0,dmax=DATA1,range=dmax-dmin||1,minSpan=Math.max(range*0.002,0.01);
  if(VE-VS>=range){VS=dmin;VE=dmax;return;}
  if(VE-VS<minSpan){const c=(VS+VE)/2;VS=c-minSpan/2;VE=c+minSpan/2;}
  if(VS<dmin){VE+=dmin-VS;VS=dmin;}
  if(VE>dmax){VS-=VE-dmax;VE=dmax;}
  if(VS<dmin)VS=dmin;if(VE>dmax)VE=dmax;}
function zoomView(f){const c=(VS+VE)/2,h=(VE-VS)/2*f;VS=c-h;VE=c+h;clampView();render();}
function panView(frac){const d=(VE-VS)*frac;VS+=d;VE+=d;clampView();render();}
// Enter expands/collapses the current row; Home/End jump to either end; the rest is in the ? help overlay
function toggleSel(){
  const i=CUR_ROWS.findIndex(x=>rowKey(x)===SEL_KEY);if(i<0)return;
  const r=CUR_ROWS[i];if(!r||!r.hasChildren||r.id==null)return;
  COLLAPSED.has(r.id)?COLLAPSED.delete(r.id):COLLAPSED.add(r.id);render();
}
function jumpEdge(dir){
  if(!CUR_ROWS.length)return;
  details(CUR_ROWS[dir>0?CUR_ROWS.length-1:0]);
  const el=document.querySelector('#namesBody .wf-row.sel');if(el)el.scrollIntoView({block:"nearest"});
}
function helpToggle(on){const h=$("#helpbox");if(h)h.classList.toggle("on",on);}
$("#helpbtn").onclick=()=>helpToggle(true);
$("#helpbox").onclick=e=>{if(e.target.id==="helpbox")helpToggle(false);};
function setFilter(v){
  FILTER=String(v||"").trim();
  const f=$("#filter");if(f&&f.value!==FILTER)f.value=FILTER;
  render();
}
$("#filter").oninput=e=>setFilter(e.target.value);
document.addEventListener("keydown",e=>{
  // Do not hijack keys while a form control has focus: pressing s in the epoch dropdown must not zoom
  const tg=e.target||{},tn=(tg.tagName||"").toUpperCase();
  if(/^(INPUT|SELECT|TEXTAREA)$/.test(tn)||tg.isContentEditable){
    if((e.key||"")==="Escape"&&tg.id==="filter"){setFilter("");tg.blur();}
    return;
  }
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  const k=(e.key||"").toLowerCase();
  if(k==="escape"){
    if($("#helpbox").classList.contains("on")){helpToggle(false);return;}
    if($("#aipanel").classList.contains("on")){$("#aipanel").classList.remove("on");$("#aiback").classList.remove("on");return;}
    if(FILTER){setFilter("");return;}
    SEL_KEY=null;document.querySelectorAll(".wf-row.sel").forEach(el=>el.classList.remove("sel"));return;
  }
  if(k==="?"||(e.shiftKey&&k==="/")){helpToggle(true);e.preventDefault();return;}
  if(k==="/"){$("#filter").focus();$("#filter").select();e.preventDefault();return;}
  if(k==="e"){setFilter(FILTER==="error"?"":"error");e.preventDefault();return;}
  if(k==="enter"){toggleSel();e.preventDefault();return;}
  if(k==="home"){jumpEdge(-1);e.preventDefault();return;}
  if(k==="end"){jumpEdge(1);e.preventDefault();return;}
  if(k==="arrowup"){navStep(-1);e.preventDefault();return;}
  if(k==="arrowdown"){navStep(1);e.preventDefault();return;}
  if(k==="w")zoomView(0.7);else if(k==="s")zoomView(1/0.7);
  else if(k==="a")panView(-0.15);else if(k==="d")panView(0.15);
  else return;
  e.preventDefault();});
// Small-screen drawers: the trace rail and detail pane get buttons and a backdrop instead of simply vanishing
(function(){
  const back=document.createElement("div");back.id="drawerback";document.body.appendChild(back);
  const rail=$("#trajrail"),det=$("#details");
  const sync=()=>{back.classList.toggle("on",rail.classList.contains("open")||det.classList.contains("open"));};
  const closeAll=()=>{rail.classList.remove("open");det.classList.remove("open");sync();};
  back.onclick=closeAll;
  window.__closeDrawers=closeAll;
  window.__openDet=()=>{det.classList.add("open");rail.classList.remove("open");sync();};
  $("#toggleRail").onclick=()=>{const on=!rail.classList.contains("open");rail.classList.toggle("open",on);det.classList.remove("open");sync();};
  $("#toggleDet").onclick=()=>{const on=!det.classList.contains("open");det.classList.toggle("open",on);rail.classList.remove("open");sync();};
})();
// Mouse zoom/pan: Ctrl+wheel zooms around the cursor, shift+wheel pans, dragging pans;
// plain wheel keeps vertical scrolling (long lists must scroll), so it is never hijacked.
(function(){
  const tb=document.getElementById("tracksBody");
  tb.addEventListener("wheel",e=>{
    if(VIEW!=="waterfall")return;
    if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey)return;
    e.preventDefault();
    const rect=tb.getBoundingClientRect();
    const frac=(e.clientX-rect.left)/rect.width||0;
    const span=VE-VS;
    if(e.shiftKey){panView((e.deltaY>0?1:-1)*0.15);return;}
    const t=VS+span*frac,f=e.deltaY<0?0.8:1/0.8;
    VS=t-(t-VS)*f;VE=VS+span*f;clampView();render();
  },{passive:false});
  let down=null,dragging=false;
  tb.addEventListener("mousedown",e=>{
    if(VIEW!=="waterfall"||e.button!==0)return;
    down={x:e.clientX,vs:VS,ve:VE};dragging=false;e.preventDefault();});
  window.addEventListener("mousemove",e=>{
    if(!down)return;
    const dx=e.clientX-down.x;
    if(Math.abs(dx)>3)dragging=true;
    if(!dragging)return;
    const rect=tb.getBoundingClientRect(),span=down.ve-down.vs;
    const dt=-(dx/rect.width)*span;
    VS=down.vs+dt;VE=down.ve+dt;clampView();render();});
  window.addEventListener("mouseup",()=>{setTimeout(()=>{down=null;dragging=false;},0);});
  // The click that ends a drag would also select a bar; swallow it in the capture phase
  tb.addEventListener("click",e=>{if(dragging){e.stopPropagation();e.preventDefault();}},true);
  // Double-clicking empty space resets the timeline, faster than reaching for "reset view"
  tb.addEventListener("dblclick",e=>{if(VIEW!=="waterfall")return;
    if(e.target.closest(".wf-row"))return;VS=DATA0;VE=DATA1;render();});
})();
// Hover time cursor: follows the pointer and shows the current instant for reading alignment
(function(){
  const wt=document.getElementById("wfTracks"),axis=document.getElementById("axis");
  const line=document.createElement("div");line.id="cursorline";
  const lab=document.createElement("div");lab.id="cursortime";
  line.appendChild(lab);wt.appendChild(line);
  wt.addEventListener("mousemove",e=>{
    if(VIEW!=="waterfall"){line.style.display="none";return;}
    // Timeline 0%–100% maps to the geometric width of #axis (16px inset on each side);
    // convert the ratio with the axis rect so the cursor line aligns with the ticks.
    const ar=axis.getBoundingClientRect();
    const frac=(e.clientX-ar.left)/ar.width;
    if(frac<0||frac>1){line.style.display="none";return;}
    const wr=wt.getBoundingClientRect();
    line.style.display="block";
    line.style.left=(e.clientX-wr.left)+"px";
    lab.textContent=(VS+frac*(VE-VS)-DATA0).toFixed(2)+"s";
  });
  wt.addEventListener("mouseleave",()=>{line.style.display="none";});
})();
