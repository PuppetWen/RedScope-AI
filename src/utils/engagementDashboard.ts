/**
 * Renders the engagement graph into a self-contained, interactive HTML page:
 * an SVG network map of the targets under test with inter-host pivot/trust/route
 * edges (including transit via network devices), a "targets under test" panel
 * with progress, a severity-ranked findings feed, and a click-a-host detail pane
 * listing that host's discovered vulnerabilities and current activity.
 *
 * The page is fully self-contained (inline CSS + JS, no external requests) so it
 * opens straight from disk. When it happens to be served over http(s) next to
 * `redscope-engagement.json`, it live-polls that file and re-renders; over
 * file:// it falls back to the embedded snapshot.
 */

import {
  ENGAGEMENT_FILENAME,
  type EngagementGraph,
  normalizeEngagementGraph,
  summarizeEngagement,
} from './engagementGraph.js'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Embed JSON safely inside a <script> tag (no </script> breakout, no U+2028/9). */
function embedJson(value: unknown): string {
  const ls = String.fromCharCode(0x2028)
  const ps = String.fromCharCode(0x2029)
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(ls).join('\\u2028')
    .split(ps).join('\\u2029')
}

export type EngagementDashboardOptions = {
  refreshFile?: string
  refreshMs?: number
  generatedAt?: string
}

export function renderEngagementDashboardHtml(
  rawGraph: EngagementGraph,
  options: EngagementDashboardOptions = {},
): string {
  const graph = normalizeEngagementGraph(rawGraph)
  const summary = summarizeEngagement(graph)
  const title = escapeHtml(graph.name ?? 'RedScope Engagement Map')
  const refreshFile = options.refreshFile ?? ENGAGEMENT_FILENAME
  const refreshMs = options.refreshMs ?? 4000
  const generatedAt = escapeHtml(options.generatedAt ?? '')
  const dataJson = embedJson(graph)
  const bootstrap = embedJson({ refreshFile, refreshMs })
  // Keep a pure summary string for the footer (no template interpolation hazard).
  void summary

  // NOTE: the client <script> below must not contain the sequence `${` or a
  // backtick, or the enclosing TS template literal would try to interpolate it.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root{
  --bg:#0a0d14; --panel:#111725; --panel2:#0d1320; --line:#1f2b3e;
  --ink:#e6edf6; --dim:#8aa0bd; --accent:#ff3860;
  --external:#f59e0b; --dmz:#a855f7; --internal:#38bdf8;
  --queued:#64748b; --scanning:#38bdf8; --testing:#f59e0b;
  --compromised:#ef4444; --clean:#22c55e; --idle:#475569;
  --critical:#ff2d55; --high:#ff6b00; --medium:#ffcc00; --low:#4ade80; --info:#60a5fa;
  --device:#94a3b8;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  background:radial-gradient(1200px 800px at 80% -10%,#12203a 0%,var(--bg) 60%);
  color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial;
}
.app{display:grid;grid-template-columns:1fr 380px;grid-template-rows:auto 1fr auto;height:100vh;gap:1px;background:var(--line)}
header{grid-column:1/3;background:linear-gradient(90deg,#0d1320,#101a2e);padding:12px 18px;display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--line)}
header .brand{font-weight:700;letter-spacing:.5px;color:#fff;font-size:16px}
header .brand b{color:var(--accent)}
header .kpis{display:flex;gap:12px;margin-left:auto;flex-wrap:wrap}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px;min-width:68px;text-align:center}
.kpi .n{font-size:18px;font-weight:700}
.kpi .l{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.6px}
.stage{position:relative;background:var(--panel2);overflow:hidden}
.stage svg{width:100%;height:100%;display:block}
.legend{position:absolute;left:12px;bottom:12px;background:rgba(10,14,22,.86);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:11px;color:var(--dim);max-width:220px}
.legend b{color:var(--ink)}
.legend .row{display:flex;align-items:center;gap:6px;margin:2px 0}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.zonecol{fill:rgba(255,255,255,.015);stroke:var(--line);stroke-dasharray:4 6}
.zonelabel{fill:var(--dim);font-size:11px;letter-spacing:2px;text-transform:uppercase}
.edge{stroke-width:1.6;fill:none;opacity:.8}
.edge.route{stroke:#64748b;stroke-dasharray:5 5}
.edge.scan{stroke:#38bdf8;stroke-dasharray:2 5}
.edge.pivot{stroke:#ef4444}
.edge.lateral{stroke:#f97316}
.edge.trust{stroke:#a855f7;stroke-dasharray:8 3}
.edge.transit{stroke:#94a3b8;stroke-dasharray:3 4}
.edge.management{stroke:#22d3ee;stroke-dasharray:1 4}
.edgelabel{fill:var(--dim);font-size:9px}
.node{cursor:pointer}
.node circle.body{stroke:#0a0d14;stroke-width:2}
.node rect.body{stroke:#0a0d14;stroke-width:2}
.node text.label{fill:var(--ink);font-size:11px;font-weight:600}
.node text.sub{fill:var(--dim);font-size:9px}
.node text.pct{fill:var(--ink);font-size:9px;font-weight:700}
.node .pulse{fill:none;stroke-width:2;opacity:.9;animation:pulse 1.8s ease-out infinite}
.node.selected circle.body,.node.selected rect.body{stroke:#fff;stroke-width:3}
.node .ring-bg{fill:none;stroke:#1f2b3e;stroke-width:3}
.node .ring-fg{fill:none;stroke-width:3;stroke-linecap:round}
@keyframes pulse{0%{r:16;opacity:.7}100%{r:34;opacity:0}}
.badge{font-weight:700}
aside{background:var(--panel);overflow-y:auto;padding:14px}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--dim);margin:16px 0 8px}
aside h2:first-child{margin-top:0}
.host-card{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--panel2)}
.host-card .name{font-size:15px;font-weight:700}
.host-card .meta{color:var(--dim);font-size:12px;margin-top:2px}
.tag{display:inline-block;background:#16233b;border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:1px 7px;font-size:10px;margin:2px 4px 0 0}
.finding{border-left:3px solid var(--line);padding:8px 10px;margin:8px 0;background:#0e1626;border-radius:0 8px 8px 0}
.finding .t{font-weight:600}
.finding .m{color:var(--dim);font-size:11px;margin-top:2px}
.sev{display:inline-block;border-radius:5px;padding:1px 6px;font-size:10px;font-weight:700;color:#0a0d14}
.sev.critical{background:var(--critical);color:#fff}
.sev.high{background:var(--high)}
.sev.medium{background:var(--medium)}
.sev.low{background:var(--low)}
.sev.info{background:var(--info)}
.status-pill{display:inline-block;border-radius:20px;padding:2px 9px;font-size:10px;font-weight:700;letter-spacing:.4px}
.feed-item{display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed var(--line);cursor:pointer}
.feed-item:hover{opacity:.85}
.muted{color:var(--dim)}
.target-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--line);cursor:pointer}
.target-row:hover{opacity:.9}
.spin{width:8px;height:8px;border-radius:50%;background:var(--scanning);box-shadow:0 0 0 0 rgba(56,189,248,.6);animation:ring 1.4s infinite;flex-shrink:0}
@keyframes ring{0%{box-shadow:0 0 0 0 rgba(56,189,248,.6)}100%{box-shadow:0 0 0 8px rgba(56,189,248,0)}}
.bar{flex:1;height:6px;background:#1a2436;border-radius:4px;overflow:hidden;min-width:40px}
.bar > i{display:block;height:100%;background:linear-gradient(90deg,#38bdf8,#f59e0b);border-radius:4px}
.pct-label{font-size:11px;color:var(--dim);min-width:34px;text-align:right}
footer{grid-column:1/3;background:var(--panel2);border-top:1px solid var(--line);padding:6px 16px;font-size:11px;color:var(--dim);display:flex;gap:12px;align-items:center}
.live{color:var(--clean)} .snap{color:var(--testing)}
.device-chip{display:inline-block;background:#1e293b;border:1px solid #334155;color:#cbd5e1;border-radius:4px;padding:0 6px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand"><b>Red</b>Scope · <span id="engName"></span></div>
    <div class="kpis" id="kpis"></div>
  </header>
  <div class="stage">
    <svg id="graph" preserveAspectRatio="xMidYMid meet"></svg>
    <div class="legend" id="legend"></div>
  </div>
  <aside>
    <h2>Targets under test</h2>
    <div id="targets"></div>
    <h2>Selected node</h2>
    <div id="detail"><div class="muted">Click a host or network device in the map to see progress and findings.</div></div>
    <h2>Findings feed</h2>
    <div id="feed"></div>
  </aside>
  <footer>
    <span id="conn" class="snap">snapshot</span>
    <span class="muted">|</span>
    <span class="muted">generated ${generatedAt}</span>
    <span class="muted">|</span>
    <span class="muted">authorized-scope engagements only</span>
  </footer>
</div>
<script id="engagement-data" type="application/json">${dataJson}</script>
<script id="engagement-bootstrap" type="application/json">${bootstrap}</script>
<script>
(function(){
  "use strict";
  var SVGNS="http://www.w3.org/2000/svg";
  var cfg=JSON.parse(document.getElementById("engagement-bootstrap").textContent);
  var data=JSON.parse(document.getElementById("engagement-data").textContent);
  var selectedId=null;
  var ZONES=["external","dmz","internal"];
  var ZONE_LABEL={external:"External",dmz:"DMZ",internal:"Internal"};
  var STATUS_COLOR={queued:"#64748b",scanning:"#38bdf8",testing:"#f59e0b",compromised:"#ef4444",clean:"#22c55e",idle:"#475569"};
  var SEV_ORDER={critical:0,high:1,medium:2,low:3,info:4};
  var DEVICE_COLOR="#94a3b8";

  function esc(s){s=(s==null)?"":String(s);return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  function el(id){return document.getElementById(id);}
  function isDevice(h){return h && (h.kind==="network-device" || h.deviceType);}
  function maxSeverity(h){
    var best=null, findings=h.findings||[];
    for(var i=0;i<findings.length;i++){var s=findings[i].severity;if(best===null||SEV_ORDER[s]<SEV_ORDER[best])best=s;}
    return best;
  }
  function svgEl(name,attrs){
    var e=document.createElementNS(SVGNS,name);
    if(attrs)for(var k in attrs){e.setAttribute(k,attrs[k]);}
    return e;
  }
  function clampPct(n){n=Number(n)||0;if(n<0)return 0;if(n>100)return 100;return Math.round(n);}

  function layout(){
    var hosts=data.hosts||[];
    var byZone={external:[],dmz:[],internal:[]};
    for(var i=0;i<hosts.length;i++){var z=hosts[i].zone||"external";(byZone[z]||byZone.external).push(hosts[i]);}
    var maxCount=Math.max(byZone.external.length,byZone.dmz.length,byZone.internal.length,1);
    var W=1100, H=Math.max(520, 110+maxCount*92);
    var colW=W/3, pos={};
    for(var zi=0;zi<ZONES.length;zi++){
      var zone=ZONES[zi], list=byZone[zone], cx=colW*zi+colW/2;
      // Put network devices slightly higher in their column so transit edges read clearly.
      var devices=[], machines=[];
      for(var k=0;k<list.length;k++){if(isDevice(list[k]))devices.push(list[k]);else machines.push(list[k]);}
      var ordered=devices.concat(machines);
      for(var j=0;j<ordered.length;j++){
        var cy=100+ (ordered.length===1 ? (H-120)/2 : (j+0.5)*((H-130)/ordered.length));
        pos[ordered[j].id]={x:cx,y:cy,zone:zone};
      }
    }
    return {W:W,H:H,colW:colW,pos:pos};
  }

  function render(){
    el("engName").textContent = data.name || "Engagement Map";
    renderKpis();
    var svg=el("graph");
    while(svg.firstChild)svg.removeChild(svg.firstChild);
    var L=layout();
    svg.setAttribute("viewBox","0 0 "+L.W+" "+L.H);

    var defs=svgEl("defs");
    var mk=svgEl("marker",{id:"arrow",viewBox:"0 0 10 10",refX:"18",refY:"5",markerWidth:"7",markerHeight:"7",orient:"auto-start-reverse"});
    mk.appendChild(svgEl("path",{d:"M0,0 L10,5 L0,10 z",fill:"#7a8aa5"}));
    defs.appendChild(mk);svg.appendChild(defs);

    for(var zi=0;zi<ZONES.length;zi++){
      svg.appendChild(svgEl("rect",{class:"zonecol",x:L.colW*zi+8,y:36,width:L.colW-16,height:L.H-48,rx:12}));
      var zl=svgEl("text",{class:"zonelabel",x:L.colW*zi+L.colW/2,y:26,"text-anchor":"middle"});
      zl.textContent=ZONE_LABEL[ZONES[zi]];svg.appendChild(zl);
    }

    var edges=data.edges||[];
    for(var e=0;e<edges.length;e++){
      var edge=edges[e];
      var a=L.pos[edge.from], b=L.pos[edge.to];
      if(!a||!b)continue;
      var viaPos=edge.via ? L.pos[edge.via] : null;
      if(viaPos){
        // Draw as a bent path through the network device so transit is visible.
        var path=svgEl("path",{
          class:"edge "+(edge.kind||"route"),
          d:"M "+a.x+" "+a.y+" Q "+viaPos.x+" "+viaPos.y+" "+b.x+" "+b.y,
          fill:"none",
          "marker-end":"url(#arrow)"
        });
        svg.appendChild(path);
        if(edge.label){
          var midX=(a.x+2*viaPos.x+b.x)/4, midY=(a.y+2*viaPos.y+b.y)/4;
          var lt=svgEl("text",{class:"edgelabel",x:midX,y:midY-4,"text-anchor":"middle"});
          lt.textContent=edge.label;svg.appendChild(lt);
        }
      } else {
        svg.appendChild(svgEl("line",{class:"edge "+(edge.kind||"route"),x1:a.x,y1:a.y,x2:b.x,y2:b.y,"marker-end":"url(#arrow)"}));
        if(edge.label){
          var lt2=svgEl("text",{class:"edgelabel",x:(a.x+b.x)/2,y:(a.y+b.y)/2-3,"text-anchor":"middle"});
          lt2.textContent=edge.label;svg.appendChild(lt2);
        }
      }
    }

    var hosts=data.hosts||[];
    for(var n=0;n<hosts.length;n++){
      var h=hosts[n], p=L.pos[h.id]; if(!p)continue;
      var g=svgEl("g",{class:"node"+(h.id===selectedId?" selected":""),transform:"translate("+p.x+","+p.y+")"});
      (function(host){g.addEventListener("click",function(){selectedId=host.id;render();});})(h);

      var color=STATUS_COLOR[h.status]||"#64748b";
      var pct=clampPct(h.progress);
      if(h.status==="scanning"||h.status==="testing"){
        g.appendChild(svgEl("circle",{class:"pulse",cx:0,cy:0,r:16,stroke:color}));
      }

      if(isDevice(h)){
        // Diamond shape for network devices (firewall / router / switch / waf / …).
        var diamond=svgEl("rect",{class:"body",x:-13,y:-13,width:26,height:26,rx:3,fill:DEVICE_COLOR,transform:"rotate(45)"});
        g.appendChild(diamond);
        var dtype=svgEl("text",{class:"pct",x:0,y:4,"text-anchor":"middle","font-size":"8",fill:"#0a0d14"});
        dtype.textContent=(h.deviceType||"net").slice(0,3).toUpperCase();
        g.appendChild(dtype);
      } else {
        g.appendChild(svgEl("circle",{class:"body",cx:0,cy:0,r:15,fill:color}));
        // Progress ring
        if(pct>0){
          var r=20, c=2*Math.PI*r, dash=(pct/100)*c;
          g.appendChild(svgEl("circle",{class:"ring-bg",cx:0,cy:0,r:String(r)}));
          g.appendChild(svgEl("circle",{class:"ring-fg",cx:0,cy:0,r:String(r),stroke:color,
            "stroke-dasharray":dash+" "+(c-dash),
            "stroke-dashoffset":String(c*0.25),
            transform:"rotate(-90)"}));
        }
      }

      var ms=maxSeverity(h);
      var findings=h.findings||[];
      if(ms){
        g.appendChild(svgEl("circle",{cx:14,cy:-14,r:8,fill:sevColor(ms),stroke:"#0a0d14","stroke-width":"1.5"}));
        var ct=svgEl("text",{class:"badge",x:14,y:-11,"text-anchor":"middle","font-size":"9","fill":ms==="medium"||ms==="low"?"#0a0d14":"#fff"});
        ct.textContent=String(findings.length);g.appendChild(ct);
      }

      var lab=svgEl("text",{class:"label",x:0,y:34,"text-anchor":"middle"});lab.textContent=h.label||h.id;g.appendChild(lab);
      var subBits=[];
      if(h.ip)subBits.push(h.ip);
      if(isDevice(h) && h.deviceType)subBits.push(h.deviceType);
      else if(h.role)subBits.push(h.role);
      if(pct>0 && (h.status==="scanning"||h.status==="testing"))subBits.push(pct+"%");
      var sub=svgEl("text",{class:"sub",x:0,y:46,"text-anchor":"middle"});sub.textContent=subBits.join(" · ");g.appendChild(sub);
      if(h.activity){
        var act=svgEl("text",{class:"sub",x:0,y:58,"text-anchor":"middle"});act.textContent=h.activity;g.appendChild(act);
      }
      svg.appendChild(g);
    }

    renderLegend();renderTargets();renderFeed();renderDetail();
  }

  function sevColor(s){return getComputedStyle(document.documentElement).getPropertyValue("--"+s).trim()||"#60a5fa";}

  function renderKpis(){
    var hosts=data.hosts||[]; var f=0,exp=0,crit=0,active=0,devices=0,prog=0;
    for(var i=0;i<hosts.length;i++){
      if(isDevice(hosts[i]))devices++;
      if(hosts[i].status==="scanning"||hosts[i].status==="testing")active++;
      prog += clampPct(hosts[i].progress);
      var findings=hosts[i].findings||[];
      for(var j=0;j<findings.length;j++){f++;if(findings[j].status==="exploited")exp++;if(findings[j].severity==="critical")crit++;}
    }
    var avg=hosts.length?Math.round(prog/hosts.length):0;
    var kpis=[["nodes",hosts.length],["net-dev",devices],["under test",active],["links",(data.edges||[]).length],["findings",f],["critical",crit],["exploited",exp],["avg %",avg]];
    var html="";
    for(var k=0;k<kpis.length;k++){html+='<div class="kpi"><div class="n">'+kpis[k][1]+'</div><div class="l">'+kpis[k][0]+'</div></div>';}
    el("kpis").innerHTML=html;
  }

  function renderLegend(){
    var html='<div class="row"><b>Host status</b></div>';
    var st=[["scanning","scanning"],["testing","testing"],["compromised","compromised"],["clean","clean"],["queued","queued"],["idle","idle"]];
    for(var i=0;i<st.length;i++){html+='<div class="row"><span class="dot" style="background:'+(STATUS_COLOR[st[i][0]]||"#64748b")+'"></span>'+st[i][1]+'</div>';}
    html+='<div class="row" style="margin-top:6px"><b>Shapes</b></div>';
    html+='<div class="row"><span class="dot" style="background:#38bdf8"></span>host (circle + progress ring)</div>';
    html+='<div class="row"><span class="dot" style="background:'+DEVICE_COLOR+';border-radius:2px;transform:rotate(45deg)"></span>network device (diamond)</div>';
    html+='<div class="row" style="margin-top:6px"><b>Links</b></div>';
    var lk=[["pivot","#ef4444"],["lateral","#f97316"],["trust","#a855f7"],["transit","#94a3b8"],["route","#64748b"],["scan","#38bdf8"],["management","#22d3ee"]];
    for(var j=0;j<lk.length;j++){html+='<div class="row"><span style="width:16px;height:0;border-top:2px solid '+lk[j][1]+'"></span>'+lk[j][0]+'</div>';}
    el("legend").innerHTML=html;
  }

  function renderTargets(){
    var hosts=(data.hosts||[]).filter(function(h){return h.status==="scanning"||h.status==="testing";});
    if(!hosts.length){el("targets").innerHTML='<div class="muted">No hosts actively under test.</div>';return;}
    var html="";
    for(var i=0;i<hosts.length;i++){
      var h=hosts[i], pct=clampPct(h.progress);
      html+='<div class="target-row" data-host="'+esc(h.id)+'"><span class="spin"></span><div style="flex:1;min-width:0"><div><b>'+esc(h.label)+'</b> <span class="muted">'+esc(h.ip||"")+'</span></div>';
      if(h.activity)html+='<div class="muted" style="font-size:11px">'+esc(h.activity)+'</div>';
      html+='<div style="display:flex;align-items:center;gap:6px;margin-top:3px"><div class="bar"><i style="width:'+pct+'%"></i></div><span class="pct-label">'+pct+'%</span></div></div></div>';
    }
    var box=el("targets");box.innerHTML=html;
    var rows=box.querySelectorAll(".target-row");
    for(var r=0;r<rows.length;r++){(function(row){row.addEventListener("click",function(){selectedId=row.getAttribute("data-host");render();});})(rows[r]);}
  }

  function collectFindings(){
    var out=[],hosts=data.hosts||[];
    for(var i=0;i<hosts.length;i++){
      var findings=hosts[i].findings||[];
      for(var j=0;j<findings.length;j++){out.push({h:hosts[i],f:findings[j]});}
    }
    out.sort(function(a,b){return SEV_ORDER[a.f.severity]-SEV_ORDER[b.f.severity];});
    return out;
  }

  function renderFeed(){
    var items=collectFindings();
    if(!items.length){el("feed").innerHTML='<div class="muted">No findings recorded yet.</div>';return;}
    var html="";
    for(var i=0;i<Math.min(items.length,40);i++){
      var it=items[i];
      html+='<div class="feed-item" data-host="'+esc(it.h.id)+'"><span class="sev '+it.f.severity+'">'+it.f.severity+'</span><div><div>'+esc(it.f.title)+'</div><div class="muted">'+esc(it.h.label)+(it.f.cve?(" · "+esc(it.f.cve)):"")+'</div></div></div>';
    }
    var box=el("feed");box.innerHTML=html;
    var rows=box.querySelectorAll(".feed-item");
    for(var r=0;r<rows.length;r++){(function(row){row.addEventListener("click",function(){selectedId=row.getAttribute("data-host");render();});})(rows[r]);}
  }

  function renderDetail(){
    var host=null,hosts=data.hosts||[];
    for(var i=0;i<hosts.length;i++)if(hosts[i].id===selectedId)host=hosts[i];
    if(!host){el("detail").innerHTML='<div class="muted">Click a host or network device in the map to see progress and findings.</div>';return;}
    var pct=clampPct(host.progress);
    var color=STATUS_COLOR[host.status]||"#64748b";
    var meta=[host.hostname,host.ip,host.os,host.zone].filter(Boolean).map(esc).join(" · ");
    var html='<div class="host-card"><div class="name">'+esc(host.label)+' <span class="status-pill" style="background:'+color+'22;color:'+color+'">'+esc(host.status)+'</span>';
    if(isDevice(host))html+=' <span class="device-chip">'+esc(host.deviceType||"network-device")+'</span>';
    html+='</div>';
    html+='<div class="meta">'+meta+'</div>';
    if(host.role)html+='<div class="meta">role: '+esc(host.role)+'</div>';
    if(host.vendor)html+='<div class="meta">vendor: '+esc(host.vendor)+'</div>';
    if(host.activity)html+='<div class="meta">activity: '+esc(host.activity)+'</div>';
    html+='<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><div class="bar" style="height:8px"><i style="width:'+pct+'%"></i></div><span class="pct-label">'+pct+'%</span></div>';
    if(host.tags&&host.tags.length){html+='<div style="margin-top:6px">';for(var t=0;t<host.tags.length;t++)html+='<span class="tag">'+esc(host.tags[t])+'</span>';html+='</div>';}
    html+='</div>';

    // Related edges for relationship network context
    var related=[];
    var edges=data.edges||[];
    for(var e=0;e<edges.length;e++){
      if(edges[e].from===host.id||edges[e].to===host.id||edges[e].via===host.id)related.push(edges[e]);
    }
    if(related.length){
      html+='<h2 style="margin-top:14px">Relationships</h2>';
      for(var ri=0;ri<related.length;ri++){
        var re=related[ri];
        html+='<div class="muted" style="font-size:12px;padding:3px 0">'+esc(re.from)+' → '+esc(re.to)+(re.via?(' via '+esc(re.via)):'')+' <span class="tag">'+esc(re.kind)+(re.label?(' · '+esc(re.label)):'')+'</span></div>';
      }
    }

    var findings=host.findings||[];
    if(!findings.length){html+='<div class="muted" style="margin-top:10px">'+(isDevice(host)?'No findings recorded on this network device.':'No vulnerabilities discovered on this host yet.')+'</div>';}
    else{
      html+='<h2 style="margin-top:14px">Findings ('+findings.length+')</h2>';
      var fs=findings.slice().sort(function(a,b){return SEV_ORDER[a.severity]-SEV_ORDER[b.severity];});
      for(var f=0;f<fs.length;f++){
        var fd=fs[f];
        html+='<div class="finding" style="border-left-color:'+sevColor(fd.severity)+'"><div class="t"><span class="sev '+fd.severity+'">'+fd.severity+'</span> '+esc(fd.title)+'</div>';
        var m=[];if(fd.cve)m.push(esc(fd.cve));if(fd.service)m.push(esc(fd.service)+(fd.port?(":"+fd.port):""));else if(fd.port)m.push("port "+fd.port);m.push("status: "+esc(fd.status));
        html+='<div class="m">'+m.join(" · ")+'</div>';
        if(fd.evidence)html+='<div class="m">'+esc(fd.evidence)+'</div>';
        html+='</div>';
      }
    }
    el("detail").innerHTML=html;
  }

  function refresh(){
    if(!cfg.refreshFile)return;
    try{
      fetch(cfg.refreshFile,{cache:"no-store"}).then(function(res){
        if(!res.ok)throw 0;return res.json();
      }).then(function(json){
        data=json;el("conn").textContent="live";el("conn").className="live";render();
      }).catch(function(){/* file:// or missing — keep snapshot */});
    }catch(e){/* ignore */}
  }

  render();
  refresh();
  if(cfg.refreshMs>0)setInterval(refresh,cfg.refreshMs);
})();
</script>
</body>
</html>
`
}
