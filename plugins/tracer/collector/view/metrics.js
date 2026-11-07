function buildFromSummary(s){
  const inf={title:tr("Inference Metrics"),cards:[],bars:[]},hw={title:tr("Hardware Metrics"),cards:[],bars:[]};
  const p=s.profiling||s.profiling_metrics||s.metrics||{};
  const card=(a,l,st,u,key)=>{if(st&&st.mean!=null)a.push({label:l,value:fv(st.mean),unit:u,key,sub:`p50 ${fv(st.p50)} · p95 ${fv(st.p95)} · p99 ${fv(st.p99)}${st.count!=null?" · n="+st.count:""}`});};
  const prof=[];card(prof,"TTFT",p.ttft,"ms","ttft");card(prof,"ITL",p.itl,"ms","itl");card(prof,"Request Latency",p.requestLatency,"ms","requestLatency");
  card(prof,"Input Throughput",p.inputThroughput,"tok/s","inputThroughput");card(prof,"Output Throughput",p.outputThroughput,"tok/s","outputThroughput");
  const srcs=(s.telemetry&&s.telemetry.sources)||[],cache=[];
  const v=srcs.find(x=>x.kind==="vllm");
  if(v){const m=seriesMap(v),kv=m["vllm:kv_cache_usage_perc"]||m["vllm:gpu_cache_usage_perc"];
    if(kv&&kv.mean!=null)cache.push({label:"KV Cache Usage",value:fv(kv.unit==="ratio"?kv.mean*100:kv.mean),unit:"%",sub:`min ${fv(kv.min)} · max ${fv(kv.max)}`});
    const hi=m["vllm:prefix_cache_hits"],qu=m["vllm:prefix_cache_queries"];
    if(hi&&qu&&hi.total!=null&&qu.total>0)cache.push({label:"Prefix Cache Hit Rate",value:fv(hi.total/qu.total*100),unit:"%",key:"cache_hit",sub:`${fv(hi.total)} / ${fv(qu.total)} tokens`});}
  inf.cards.push(...cache,...prof);
  const lit=[];[['TTFT','ttft'],['ITL','itl'],['Req Latency','requestLatency']].forEach(([nm,k])=>{const st=p[k];if(!st)return;['p50','p95','p99'].forEach(key=>{if(st[key]!=null)lit.push({label:nm+' '+key,value:st[key],color:PAL[lit.length%7]});});});
  bars(inf.bars,tr("Latency percentiles"),"ms",lit);
  bars(inf.bars,tr("Throughput"),"tok/s",[{label:tr("Input"),value:meanOf(p.inputThroughput),color:PAL[0]},{label:tr("Output"),value:meanOf(p.outputThroughput),color:PAL[1]},{label:tr("Total"),value:meanOf(p.totalThroughput),color:PAL[2],key:"throughput"}]);
  const a=srcs.find(x=>x.kind==="ascend");
  if(a){const m=seriesMap(a),push=(l,k,u)=>{const x=m[k];if(x&&x.mean!=null)hw.cards.push({label:l,value:fv(x.mean),unit:u,key:k,sub:`min ${fv(x.min)} · max ${fv(x.max)}`});};
    push(tr("NPU Utilization"),"ascend_npu_utilization_percent","%");push(tr("AI Core Utilization"),"ascend_npu_aicore_utilization_percent","%");
    push(tr("HBM Usage"),"ascend_npu_hbm_usage_percent","%");push(tr("HBM Bandwidth"),"ascend_npu_hbm_bandwidth_percent","%");
    push(tr("HBM Capacity"),"ascend_npu_hbm_capacity_megabytes","MB");push(tr("Power"),"ascend_npu_power_watts","W");push(tr("Temperature"),"ascend_npu_temperature_celsius","°C");
    bars(hw.bars,tr("Utilization (mean)"),"%",[{label:"NPU",value:meanOf(m["ascend_npu_utilization_percent"]),color:PAL[0]},{label:"AI Core",value:meanOf(m["ascend_npu_aicore_utilization_percent"]),color:PAL[4]},{label:"HBM",value:meanOf(m["ascend_npu_hbm_usage_percent"]),color:PAL[1]},{label:"HBM BW",value:meanOf(m["ascend_npu_hbm_bandwidth_percent"]),color:PAL[2]}]);}
  // Measurement trust: when sampling is incomplete or incomparable the numbers still look good but the conclusion is void, so it gets its own block before them
  const L=x=>Array.isArray(x)?x.filter(Boolean):(x?[String(x)]:[]),trust=[],SEP=tr("; ");
  if(typeof s.comparable==="boolean")
    trust.push({k:tr("Comparability"),v:s.comparable?tr("comparable"):tr("not comparable"),cls:s.comparable?"ok":"bad",
      d:s.comparable?"":L(s.incomparableReasons).slice(0,3).map(reasonCN).join(SEP)});
  if(s.upstreamSubmissionValid===false)
    trust.push({k:tr("Upstream submission"),v:tr("invalid"),cls:"bad",d:L(s.upstreamInvalidReasons).slice(0,3).join(SEP)});
  // Collection errors are an all-endpoints total: peel them out of each source and show them only once
  const globals=[];
  srcs.forEach(src=>{
    const n=s.telemetry&&s.telemetry.collectionErrors;
    if(typeof n==="number")globals.push(n);
    splitErrors(src.errors).glob.forEach(g=>globals.push(g.n));
  });
  if(globals.length){
    const n=Math.max(...globals);
    trust.push({k:tr("Collection errors"),v:tr("{n} times",{n}),cls:"warn",
      d:tr("Total across all endpoints; cannot be attributed to a specific source. Collection continues after transient failures and completed statistics are kept.")});
  }
  srcs.forEach(src=>{
    const label=src.kind==="vllm"?tr("vLLM samples"):src.kind==="ascend"?tr("NPU samples"):tr("{kind} samples",{kind:(src.kind||tr("unknown"))});
    const bits=[];
    if(src.deviceId!=null)bits.push(tr("device {id}",{id:src.deviceId}));
    if(src.samples!=null)bits.push(tr("{n} samples",{n:fmtNum(src.samples)}));
    const miss=L(src.missingMetrics);
    if(miss.length)bits.push(tr("{n} metrics missing: {list}{more}",{n:miss.length,list:miss.slice(0,3).join(tr(", ")),more:miss.length>3?tr(" …"):""}));
    const own=splitErrors(src.errors).own;
    if(own.length)bits.push(tr("{n} error kinds: {list}",{n:own.length,list:own.map(x=>x.text).join(SEP)}));
    trust.push({k:label,v:statusCN(src.status),cls:statusCls(src.status),d:bits.join(" · ")});
  });
  const rc=s.replayCoverage;
  if(rc&&(rc.expectedRequests!=null||rc.complete!=null)){
    const bits=[];
    if(rc.expectedRequests!=null)bits.push(tr("{n} requests expected",{n:rc.expectedRequests}));
    if(rc.observedRequests!=null)bits.push(tr("{n} observed",{n:rc.observedRequests}));
    if(rc.missingRequests)bits.push(tr("{n} missing",{n:rc.missingRequests}));
    if(rc.duplicateRequests)bits.push(tr("{n} duplicated",{n:rc.duplicateRequests}));
    if(rc.unexpectedRequests)bits.push(tr("{n} unexpected",{n:rc.unexpectedRequests}));
    trust.push({k:tr("Replay coverage"),v:rc.complete?tr("complete"):tr("incomplete"),cls:rc.complete?"ok":"bad",d:bits.join(" · ")});
  }
  // Main metrics exclude the warmup period, but the warmup sample count decides how many valid requests the numbers represent, so spell it out
  const wu=(s.warmup||{}).ttft;
  if(wu&&wu.count!=null){
    const bits=["n="+wu.count];
    if(wu.p50!=null)bits.push("TTFT p50 "+secFmt(wu.p50));
    if(wu.p95!=null)bits.push("p95 "+secFmt(wu.p95));
    trust.push({k:tr("Warmup"),v:tr("excluded"),cls:"",key:"warmup_ttft_p95",d:bits.join(" · ")});
  }
  if(trust.length)inf.trust=trust;
  return{inf,hw};
}
// agentx standard emits one summary per concurrency level (c1/c4/c8). A single summary keeps the card layout above;
// multiple summaries switch to a "columns = levels, rows = metrics" table with one shared trust block, so three sets of numbers do not drown each other.
const concOf=s=>{const w=(s&&s.workload)||{},v=w.concurrency!=null?w.concurrency:(s&&s.concurrency);return typeof v==="number"?v:null;};
const sumKeyOf=s=>{const w=(s&&s.workload)||{},c=concOf(s);
  return [w.mode||s.metrics_phase||"single",w.variant||"",c!=null?"c"+c:"single"].join("|");};
function buildFromSummaries(items){
  const list=(items||[]).filter(Boolean);
  if(list.length<=1)return buildFromSummary(list[0]||{});
  const pts=list.slice().sort((a,b)=>{const x=concOf(a),y=concOf(b);
    if(x==null)return 1;if(y==null)return -1;return x-y;});
  const prof=s=>(s&&(s.profiling||s.profiling_metrics||s.metrics))||{};
  const stat=(s,k,f)=>{const x=prof(s)[k];return x&&x[f]!=null?x[f]:null;};
  const label=s=>{const c=concOf(s);return c!=null?"c"+c:tr("single tier");};
  const L=x=>Array.isArray(x)?x.filter(Boolean):(x?[String(x)]:[]);
  const tok=v=>v==null?null:(Math.abs(v)>=1e6?(v/1e6).toFixed(2)+"M":Math.abs(v)>=1e3?(v/1e3).toFixed(1)+"k":String(Math.round(v)));
  // Units move into the row label so cells hold numbers only. Inline mini bars normalize to the row max
  // to compare magnitude across levels; no extra "first vs last" percentage column, because with more
  // levels that derived column ignores the middle ones and cannot justify picking only the ends.
  const row=(name,fn,fmt,key)=>{
    const raw=pts.map(fn),f=fmt||fv;
    return{label:name,key,cells:raw.map(v=>({raw:v,text:v==null?null:f(v)}))};
  };
  // Prefix cache hit rate: LLM suggestions locate this row by cache_hit
  const cacheRate=s=>{
    const src=((s.telemetry&&s.telemetry.sources)||[]).find(x=>x.kind==="vllm");
    if(!src)return null;
    const m=seriesMap(src);
    const q=(m["vllm:prefix_cache_queries"]||{}).total,h=(m["vllm:prefix_cache_hits"]||{}).total;
    return(typeof q==="number"&&q>0&&typeof h==="number")?h/q:null;
  };
  const w=pts[0].workload||{},SEP=tr("; ");
  const subtitle=[tr("{n} tiers",{n:pts.length}),w.mode||"",w.variant||""].filter(Boolean).join(" · ");
  const inf={title:tr("Inference Metrics"),subtitle,cards:[],bars:[],table:{
    cols:pts.map(label),
    rows:[
      row(tr("Requests"),s=>stat(s,"requests","mean"),null,"requests"),
      row("TTFT mean (ms)",s=>stat(s,"ttft","mean"),v=>v==null?null:Math.round(v),"ttft_mean"),
      row("TTFT p95 (ms)",s=>stat(s,"ttft","p95"),v=>v==null?null:Math.round(v),"ttft_p95"),
      row("ITL mean (ms)",s=>stat(s,"itl","mean"),v=>v==null?null:+v.toFixed(1),"itl_mean"),
      row(tr("Req Latency p95 (s)"),s=>{const v=stat(s,"requestLatency","p95");return v==null?null:v/1000;},v=>v==null?null:+v.toFixed(1),"latency_p95"),
      row(tr("Total throughput (tok/s)"),s=>stat(s,"totalThroughput","mean"),null,"throughput"),
      row(tr("Interactivity (tok/s/user)"),s=>stat(s,"interactivity","mean"),null,"interactivity"),
      row(tr("Prefix Cache hit rate"),cacheRate,v=>v==null?null:(v*100).toFixed(1)+"%","cache_hit"),
      // Request count and tokens measure workload, not quality; leave them uncolored so "more" is not read as "better"
      row(tr("Input tokens"),s=>stat(s,"inputTokens","mean"),tok,"input_tokens"),
      row(tr("Output tokens"),s=>stat(s,"outputTokens","mean"),tok,"output_tokens"),
      row(tr("Measurement duration (min)"),s=>{const v=stat(s,"duration","mean");return v==null?null:v/60;},v=>v==null?null:Math.round(v),"duration_s"),
    ]}};
  const trust=[];
  const cmp=pts.filter(s=>typeof s.comparable==="boolean");
  if(cmp.length){const bad=pts.filter(s=>s.comparable===false);
    trust.push({k:tr("Comparability"),v:bad.length?tr("{n} tiers not comparable",{n:bad.length}):tr("all comparable"),cls:bad.length?"bad":"ok",
      d:bad.map(s=>label(s)+": "+(L(s.incomparableReasons).slice(0,2).map(reasonCN).join(SEP)||tr("no reason given"))).join(" · ")});}
  const up=pts.filter(s=>s.upstreamSubmissionValid===false);
  if(up.length)trust.push({k:tr("Upstream submission"),v:tr("{n} tiers invalid",{n:up.length}),cls:"bad",
    d:up.map(s=>label(s)+": "+(L(s.upstreamInvalidReasons).slice(0,2).join(SEP)||tr("no reason given"))).join(" · ")});
  // Collection errors are an all-endpoints total shown once even across levels; old summaries repeated the same copy per source, so merge and dedupe
  const globals=[];
  pts.forEach(s=>{
    const n=s.telemetry&&s.telemetry.collectionErrors;
    if(typeof n==="number")globals.push({n,label:label(s)});
    ((s.telemetry&&s.telemetry.sources)||[]).forEach(src=>{
      splitErrors(src.errors).glob.forEach(g=>globals.push({n:g.n,label:label(s)}));});
  });
  if(globals.length){
    const n=Math.max(...globals.map(x=>x.n));
    const ls=[...new Set(globals.map(x=>x.label))];
    trust.push({k:tr("Collection errors"),v:tr("{n} times",{n}),cls:"warn",
      d:(ls.length<pts.length?ls.join("/")+" · ":"")+tr("Total across all endpoints; cannot be attributed to a specific source. Collection continues after transient failures and completed statistics are kept.")});
  }
  const byKind={};
  pts.forEach(s=>((s.telemetry&&s.telemetry.sources)||[]).forEach(src=>{
    const k=src.kind||"unknown";(byKind[k]=byKind[k]||[]).push({src,label:label(s)});}));
  Object.keys(byKind).forEach(kind=>{
    const list_=byKind[kind];
    const dirs=new Set(list_.map(x=>x.label));
    // Dedupe per-source errors by text after stripping the global total; name levels only when a subset is affected, so a partial failure is not read as all levels
    const errMap=new Map();
    list_.forEach(x=>splitErrors(x.src.errors).own.forEach(e=>{
      if(!errMap.has(e.text))errMap.set(e.text,new Set());
      errMap.get(e.text).add(x.label);}));
    const own=[...errMap.entries()].map(([text,ls])=>text+(ls.size<dirs.size?" ("+[...ls].join("/")+")":""));
    const rank=v=>({complete:0,partial:1,unavailable:2})[v]??-1;
    const worst=list_.slice().sort((a,b)=>rank(b.src.status)-rank(a.src.status))[0];
    const samples=list_.reduce((a,x)=>a+(x.src.samples||0),0);
    const devices=[...new Set(list_.map(x=>x.src.deviceId).filter(v=>v!=null))];
    const bits=[tr("tier status: {list}",{list:list_.map(x=>x.label+" "+statusCN(x.src.status)).join(" · ")})];
    if(samples)bits.push((dirs.size>1?tr("{n} tiers total ",{n:dirs.size}):"")+tr("{n} samples",{n:fmtNum(samples)}));
    if(devices.length)bits.push(tr("device {id}",{id:devices.join(tr(", "))}));
    if(own.length)bits.push(tr("{n} error kinds: {list}",{n:own.length,list:own.join(SEP)}));
    const name=kind==="vllm"?tr("vLLM samples"):kind==="ascend"?tr("NPU samples"):tr("{kind} samples",{kind});
    trust.push({k:name,v:statusCN(worst.src.status),cls:statusCls(worst.src.status),d:bits.join(" · ")});
  });
  // With multiple levels on one page, list warmup sample counts and TTFT ranges per level to show how many cold-start requests the main metrics dropped
  const warm=pts.map(s=>({l:label(s),t:(s.warmup||{}).ttft})).filter(x=>x.t&&x.t.count!=null);
  if(warm.length){
    const rg=v=>{const a=Math.min(...v),b=Math.max(...v);return a===b?secFmt(a):secFmt(a)+"–"+secFmt(b);};
    const bits=warm.map(x=>x.l+" n="+x.t.count);
    const p50=warm.map(x=>x.t.p50).filter(v=>v!=null);
    const p95=warm.map(x=>x.t.p95).filter(v=>v!=null);
    if(p50.length)bits.push("TTFT p50 "+rg(p50));
    if(p95.length)bits.push("p95 "+rg(p95));
    trust.push({k:tr("Warmup"),v:tr("excluded"),cls:"",key:"warmup_ttft_p95",d:bits.join(" · ")});
  }
  if(trust.length)inf.trust=trust;
  const hw={title:tr("Hardware Metrics"),subtitle,cards:[],bars:[],table:null};
  const hasHw=pts.some(s=>((s.telemetry&&s.telemetry.sources)||[]).some(x=>x.kind==="ascend"&&(x.series||[]).length));
  if(hasHw){
    const get=(s,k)=>{const src=((s.telemetry&&s.telemetry.sources)||[]).find(x=>x.kind==="ascend");
      const m=seriesMap(src);return m[k]&&m[k].mean!=null?m[k].mean:null;};
    hw.table={cols:pts.map(label),rows:[
      [tr("NPU Utilization (%)"),"ascend_npu_utilization_percent"],
      [tr("AI Core Utilization (%)"),"ascend_npu_aicore_utilization_percent"],
      [tr("HBM Usage (%)"),"ascend_npu_hbm_usage_percent"],
      [tr("HBM Bandwidth (%)"),"ascend_npu_hbm_bandwidth_percent"],
      [tr("HBM Capacity (MB)"),"ascend_npu_hbm_capacity_megabytes"],
      [tr("Power (W)"),"ascend_npu_power_watts"],
      [tr("Temperature (°C)"),"ascend_npu_temperature_celsius"],
    ].map(([name,k])=>row(name,s=>get(s,k),null,k))};
  }
  return{inf,hw};
}
// Merged metrics page: inference and hardware on one screen, so a missing half no longer takes a blank page of its own
// Inference and hardware metrics only come from AgentX profiling runs; an ordinary evaluation run never ships that summary,
// so its empty state must not point at agentx-summary.json.
function agentxRun(){
  if(METRICS_RAW&&(METRICS_RAW.kind==="agentx"||METRICS_RAW.profiling||METRICS_RAW.profiling_metrics))return true;
  const kinds=[...SUMMARIES.values()].map(s=>String((s.workload&&s.workload.kind)||s.kind||""));
  return kinds.length>0&&kinds.every(k=>k==="agentx");
}
const METRIC_EMPTY_TITLE=()=>tr("No metrics");
const METRIC_EMPTY_BODY=()=>agentxRun()
  ?tr("This epoch reported no inference metrics (TTFT / ITL / throughput) or hardware metrics (NPU / HBM / power). The evaluator returns agentx-summary.json when a run finishes; it appears here after import.")
  :tr("This run reported no inference or hardware metrics. Those metrics are collected by AgentX profiling runs; this run's agent and tool steps are on the Trajectory tab.");
function trustHTML(tre){
  if(!tre||!tre.length)return "";
  const issue=tre.filter(t=>t.cls==="bad"||t.cls==="warn").length;
  return '<div class="trust"><h4>'+tr("Measurement trust")+'<span>'+(issue?tr("{n} items need attention",{n:issue}):tr("No issues"))+'</span></h4><div class="tgrid">'+
    tre.map(t=>`<b>${esc(t.k)}</b><span class="${t.cls||''}"${t.key?' data-metric="'+esc(t.key)+'"':''}>${esc(t.v)}${t.d?'<i>'+esc(t.d)+'</i>':''}</span>`).join('')+'</div></div>';
}
// Render only non-empty blocks; renderMetrics owns the empty state, so merging never leaves an "inference yes, hardware none" stub
function metricBodyHTML(m){
  if(!m)return "";
  const tbl=m.table||null,hasTbl=!!(tbl&&tbl.rows&&tbl.rows.length);
  if(!m.cards.length&&!m.bars.length&&!hasTbl)return "";
  let h="";
  // Multiple levels: one table puts all concurrency levels side by side, missing values shown as a dimmed — rather than hiding the row.
  // Each value is preceded by an inline mini bar (normalized to the row max) so magnitude trends live inside the table.
  if(hasTbl){
    h+='<div class="xcmp"><table><thead><tr><th>'+tr("Metric")+'</th>'+tbl.cols.map(c=>`<th title="${esc(String(c))}">${esc(c)}</th>`).join('')+'</tr></thead><tbody>'+
      tbl.rows.map(r=>{
        const mx=r.cells.reduce((a,c)=>c.raw==null?a:Math.max(a,Math.abs(c.raw)),0);
        // Metric and level names get clipped by horizontal scrolling on narrow screens, so hover reveals the full text
        return '<tr'+(r.key?' data-metric="'+esc(r.key)+'"':'')+'><td title="'+esc(r.label)+'">'+esc(r.label)+'</td>'+r.cells.map((c,i)=>{
          if(c.text==null)return '<td><span class="na">—</span></td>';
          const w=mx?Math.max(3,Math.abs(c.raw)/mx*100):0;
          return '<td><div class="vc"><span class="vbar"><i style="width:'+w.toFixed(0)+'%;background:'+PAL[i%PAL.length]+'"></i></span><b>'+esc(String(c.text))+'</b></div></td>';
        }).join('')+'</tr>';
      }).join('')+'</tbody></table></div>';}
  if(m.cards.length)h+='<div class="cards">'+m.cards.map(c=>`<div class="card"${c.key?' data-metric="'+esc(c.key)+'"':''}><div class="lbl">${esc(c.label)}</div><div class="val">${esc(c.value)}<small> ${esc(c.unit||'')}</small></div><div class="sub">${esc(c.sub||'')}</div></div>`).join('')+'</div>';
  (m.bars||[]).forEach(g=>{const mx=Math.max(...g.items.map(i=>Math.abs(i.value)))||1;
    h+=`<div class="bars"><h4>${esc(g.title)} <span style="text-transform:none">(${esc(g.unit||'')})</span></h4>`+g.items.map(i=>`<div class="bar-row"${i.key?' data-metric="'+esc(i.key)+'"':''}><div class="bl">${esc(i.label)}</div><div class="bt"><div class="bf" style="width:${(Math.abs(i.value)/mx*100).toFixed(1)}%;background:${i.color||PAL[0]}"></div></div><div class="bv">${esc(fv(i.value))}</div></div>`).join('')+'</div>';});
  return h;
}
function renderMetrics(){
  const m=METRICS||{inf:null,hw:null},el=$("#metpane");if(!el)return;
  const infBody=metricBodyHTML(m.inf),hwBody=metricBodyHTML(m.hw);
  const tre=(m.inf&&m.inf.trust)||[];
  if(!infBody&&!hwBody&&!tre.length){
    el.innerHTML='<div class="emptyfull">'+emptyHTML(METRIC_EMPTY_TITLE(),METRIC_EMPTY_BODY())+'</div>';return;}
  const sub=(m.inf&&m.inf.subtitle)||(m.hw&&m.hw.subtitle)||"";
  const srcNote=(METRICS_RAW&&METRICS_RAW.kind==="agentx")
    ?tr("Source: profiling / warmup / telemetry fields of agentx-summary.json")
    :tr("Source: summary data returned by the evaluator");
  let h='<h3>'+tr("Metrics")+'</h3><div class="mtitle">'+(sub?esc(sub)+" · ":"")+esc(srcNote)+'</div>';
  h+=trustHTML(tre);
  if(infBody)h+='<h4 class="msec">'+tr("Inference Metrics")+'</h4>'+infBody;
  if(hwBody)h+='<h4 class="msec">'+tr("Hardware Metrics")+'</h4>'+hwBody;
  el.innerHTML=h;
}
