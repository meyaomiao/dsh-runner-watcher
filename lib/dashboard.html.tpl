<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
__REFRESH_META__
<title>Runner Watcher · 自托管 Runner 观测</title>
<style>
:root {
  --bg:#0b1020; --card:#141b2d; --ink:#e8eefc; --muted:#93a0bf; --line:#243049;
  --ok:#3dd68c; --bad:#ff6b7a; --idle:#7aa2ff; --busy:#ffc857; --acc:#6ee7ff;
  --rps:#7ee0c3; --rel:#7aa2ff; --spd:#ffc857; --eff:#c084fc; --stb:#fb923c;
}
* { box-sizing:border-box; }
body { margin:0; font-family:"Segoe UI",system-ui,-apple-system,"Noto Sans SC",sans-serif; background:radial-gradient(1200px 600px at 10% -10%,#1a2744 0%,var(--bg) 55%); color:var(--ink); }
header { padding:28px 32px 8px; }
h1 { margin:0 0 6px; font-size:28px; letter-spacing:.3px; }
.sub { color:var(--muted); font-size:13px; }
.wrap { padding:16px 32px 48px; display:grid; gap:16px; grid-template-columns:minmax(0,1fr); }
.row { display:grid; gap:16px; grid-template-columns:repeat(4,minmax(0,1fr)); }
.row > * { min-width:0; }
@media (max-width:1400px){ .row { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (max-width:960px){ .row { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:600px){ .row { grid-template-columns:minmax(0,1fr); } }
.card { background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.01)); border:1px solid var(--line); border-radius:16px; padding:16px 18px; box-shadow:0 10px 30px rgba(0,0,0,.18); }
.k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
.v { font-size:28px; font-weight:650; margin-top:6px; }
.pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
.ok { background:rgba(61,214,140,.15); color:var(--ok); }
.bad { background:rgba(255,107,122,.15); color:var(--bad); }
.idle { background:rgba(122,162,255,.15); color:var(--idle); }
.busy { background:rgba(255,200,87,.18); color:var(--busy); }
.off { background:rgba(147,160,191,.12); color:var(--muted); }
.gradeS { background:rgba(126,224,195,.2); color:#7ee0c3; }
.gradeA { background:rgba(61,214,140,.18); color:var(--ok); }
.gradeB { background:rgba(122,162,255,.18); color:var(--idle); }
.gradeC { background:rgba(255,200,87,.18); color:var(--busy); }
.gradeD { background:rgba(251,146,60,.18); color:#fb923c; }
.gradeF { background:rgba(255,107,122,.18); color:var(--bad); }
table { width:100%; border-collapse:collapse; font-size:13px; }
#registry, #names, #jobs { min-width:0; overflow-x:auto; }
th,td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
.bar { height:8px; background:#1c2740; border-radius:99px; overflow:hidden; }
.bar>i { display:block; height:100%; background:linear-gradient(90deg,var(--acc),var(--ok)); }
.muted { color:var(--muted); }
.mono { font-family:ui-monospace,Consolas,"SF Mono",monospace; font-size:12px; }
.flex { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
h2 { margin:0 0 10px; font-size:16px; }
.small { font-size:12px; color:var(--muted); }
.chart-wrap { position:relative; width:100%; height:340px; }
.chart-wrap canvas { width:100%; height:100%; display:block; cursor:crosshair; }
.tip {
  position:absolute; pointer-events:none; min-width:220px; max-width:340px;
  background:#0f172aee; border:1px solid var(--line); border-radius:10px;
  padding:10px 12px; font-size:12px; line-height:1.45; display:none; z-index:5;
  box-shadow:0 12px 28px rgba(0,0,0,.35);
}
.tip b { font-size:14px; }
.legend { display:flex; gap:14px; flex-wrap:wrap; margin:8px 0 4px; font-size:12px; }
.legend label { display:flex; align-items:center; gap:6px; cursor:pointer; color:var(--muted); user-select:none; }
.legend i { width:12px; height:3px; border-radius:2px; display:inline-block; }
.legs { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-top:10px; }
.leg { background:#10182a; border:1px solid var(--line); border-radius:10px; padding:8px 10px; }
.leg .k { font-size:10px; }
.leg .v { font-size:18px; }
.formula { font-size:12px; color:var(--muted); line-height:1.55; }
.empty { border:1px dashed var(--line); border-radius:12px; padding:18px; }
pre { background:#0d1424; border:1px solid var(--line); border-radius:10px; padding:10px 12px; overflow:auto; font-size:12px; margin:8px 0 0; }
.small, .card p { overflow-wrap:anywhere; }
.mono { word-break:break-all; }
code { font-family:ui-monospace,Consolas,"SF Mono",monospace; }
</style>
</head>
<body>
<header>
  <h1>Runner Watcher</h1>
  <div class="sub"><span id="meta"></span> <span id="live-ts"></span></div>
</header>
<div class="wrap">
  <div id="empty"></div>
  <div class="row" id="kpis"></div>
  <div class="row" id="runners"></div>
  <div class="card">
    <div class="flex">
      <h2 style="margin:0">Runner 综合表现分（RPS）趋势</h2>
      <span class="pill idle" id="scoreNow"></span>
    </div>
    <p class="formula" id="formula"></p>
    <div class="legend" id="legend"></div>
    <div class="chart-wrap">
      <canvas id="trend"></canvas>
      <div class="tip" id="tip"></div>
    </div>
    <div class="small" id="trendHint">横轴=任务完成时间 · 综合分为滚动窗口 · 悬停查看该点四维明细</div>
  </div>
  <div class="card">
    <h2>已接入的 Runner</h2>
    <div id="registry"></div>
  </div>
  <div class="card">
    <h2>按任务名聚合</h2>
    <div id="names"></div>
  </div>
  <div class="card">
    <h2>最近任务</h2>
    <div id="jobs"></div>
  </div>
</div>
<script>
const DATA = __PAYLOAD__;
const $ = (id) => document.getElementById(id);
const fmtB = (n) => {
  n = Number(n||0);
  const u = ['B','KB','MB','GB','TB'];
  let i=0; while(n>=1024 && i<u.length-1){n/=1024;i++;}
  return (i? n.toFixed(1): n.toFixed(0)) + ' ' + u[i];
};
const fmtS = (s) => {
  if (s==null || s==='') return '-';
  s = Number(s);
  if (!isFinite(s)) return '-';
  if (s<60) return s.toFixed(1)+'s';
  const m=Math.floor(s/60), r=Math.round(s%60);
  if (m<60) return m+'m'+String(r).padStart(2,'0')+'s';
  const h=Math.floor(m/60); return h+'h'+String(m%60).padStart(2,'0')+'m';
};
const fmtN = (v, d=1) => (v==null || v==='') ? '-' : Number(v).toFixed(d);
const esc = (s) => String(s==null?'':s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pill = (st) => {
  const cls = st==='idle'?'idle': st==='busy'?'busy': (st==='present'?'ok': (st==='missing'||st==='error'||st==='failed'?'bad':'off'));
  return '<span class="pill '+cls+'">'+esc(st)+'</span>';
};
const resPill = (r) => {
  if (r==='Succeeded' || r==='Success') return '<span class="pill ok">'+esc(r)+'</span>';
  if (r==='Running') return '<span class="pill busy">'+esc(r)+'</span>';
  return '<span class="pill bad">'+esc(r||'?')+'</span>';
};
const gradePill = (g) => '<span class="pill grade'+(g||'F')+'">'+esc(g||'-')+'</span>';
const gradeOf = (s) => {
  if (s==null) return '-';
  if (s>=90) return 'S'; if (s>=80) return 'A'; if (s>=70) return 'B';
  if (s>=60) return 'C'; if (s>=50) return 'D'; return 'F';
};

const snap = DATA.snap || {};
const st = DATA.stats || {};
const rps = DATA.rps || st.rps || {};
const model = DATA.score_model || st.score_model || {};
const w = model.weights || {reliability:0.4,speed:0.25,efficiency:0.2,stability:0.15};
const registry = DATA.registry || {runners: [], pending: []};
const snapshots = snap.runners || [];

$('meta').textContent = '生成于 ' + fmtTs(DATA.generated)
  + ' · 窗口 ' + DATA.hours + ' 小时'
  + ' · 主机 ' + ((snap.host||{}).hostname || '-')
  + ' · 数据目录 ' + (DATA.dataDir || '-');

$('formula').textContent =
  'RPS = 可靠 ' + Math.round(w.reliability*100) + '% + 速度 ' + Math.round(w.speed*100) +
  '% + 效率 ' + Math.round(w.efficiency*100) + '% + 稳定 ' + Math.round(w.stability*100) +
  '%    等级 S≥90 / A≥80 / B≥70 / C≥60 / D≥50 / F';
$('trendHint').textContent =
  '横轴=任务完成时间 · 综合分为最近 ' + (model.rollingWindow || 6) + ' 次任务的滚动窗口 · 悬停查看该点四维明细';

if (!registry.runners.length) {
  $('empty').innerHTML = `<div class="card empty">
    <h2>还没有接入任何 Runner</h2>
    <p class="small">两种方式二选一：自己导入，或让自动发现把找到的 runner 关联进来。</p>
    <p class="small"><b>1) 手动导入</b>（路径指向 runner 安装目录，即含 <code>.runner</code> 的那一层）</p>
    <pre>dsh-runner-watcher add --kind wsl --distro Ubuntu --path /opt/actions-runner
dsh-runner-watcher add --kind local --path /opt/actions-runner
dsh-runner-watcher add --kind ssh --host build-01 --path /home/ci/actions-runner</pre>
    <p class="small"><b>2) 自动发现 + 关联</b>（按 GitHub agent 身份匹配，不会产生重复条目）</p>
    <pre>dsh-runner-watcher discover --transport wsl:Ubuntu
dsh-runner-watcher discover --transport wsl:Ubuntu --adopt
dsh-runner-watcher collect</pre>
    <p class="small">在 DSH 会话里也可以直接让 agent 调用 <code>runner_watcher_add</code> / <code>runner_watcher_discover</code>。</p>
  </div>`;
}

const kpis = [
  ['综合表现 RPS', (rps.score!=null? rps.score : '-') + '  ' + (rps.grade||'')],
  ['已接入 Runner', registry.runners.length],
  ['完成任务', st.completed||0],
  ['成功率', ((st.success_rate||0)*100).toFixed(1)+'%'],
  ['任务均分', st.job_score_avg||0],
  ['可靠 / 速度', fmtN(rps.reliability)+' / '+fmtN(rps.speed)],
];
$('kpis').innerHTML = kpis.map(([k,v])=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+esc(v)+'</div></div>').join('');

const host = snap.host||{};
const mem = host.memory||{};
const byRunner = st.by_runner || {};
const registryById = new Map((registry.runners||[]).map((r) => [r.id, r]));

$('runners').innerHTML = snapshots.map((r) => {
  const entry = registryById.get(r.id) || {};
  const memPct = r.memory_peak_bytes ? Math.min(100, 100*r.memory_current_bytes/r.memory_peak_bytes) : 0;
  const job = r.current_job ? ('当前任务 ' + esc(r.current_job.name)) : '空闲';
  const rs = byRunner[r.label] || {};
  const id = r.identity || {};
  return `<div class="card" data-live-id="${esc(r.id)}">
    <div class="flex"><strong>${esc(r.label)}</strong> <span data-live="state">${pill(r.state)}</span> ${gradePill(rs.grade)}</div>
    <div class="small">${esc(id.githubUrl||'')}</div>
    <div class="small mono">${esc(r.source||'')}</div>
    <p class="small">agent ${esc(id.agentName||'-')} #${esc(id.agentId ?? '-')} · pool ${esc(id.poolName||'-')} · 来源 ${esc(entry.addedBy||'-')}</p>
    <p class="small">RPS ${fmtN(rs.rps)} · 任务均分 ${fmtN(rs.job_score_avg)} · 成功 ${(rs.success_rate!=null?(rs.success_rate*100).toFixed(1):'-')}%</p>
    <div class="legs">
      <div class="leg"><div class="k">可靠</div><div class="v">${fmtN(rs.reliability,0)}</div></div>
      <div class="leg"><div class="k">速度</div><div class="v">${fmtN(rs.speed_score,0)}</div></div>
      <div class="leg"><div class="k">效率</div><div class="v">${fmtN(rs.efficiency_avg,0)}</div></div>
      <div class="leg"><div class="k">稳定</div><div class="v">${fmtN(rs.stability,0)}</div></div>
    </div>
    <p class="small" data-live="job">${job}</p>
    <p class="small" data-live="mem">cgroup 内存 ${fmtB(r.memory_current_bytes)} / 峰值 ${fmtB(r.memory_peak_bytes)}</p>
    <div class="bar"><i style="width:${memPct.toFixed(1)}%"></i></div>
    <p class="small">CPU 累计 ${((r.cpu_usage_sec||0)/60).toFixed(1)} min · 进程 RSS ${fmtB(r.process_rss_bytes)} · _work ${fmtB(r.work_bytes)}</p>
    ${r.error ? '<p class="small bad">'+esc(r.error)+'</p>' : ''}
  </div>`;
}).join('') + `<div class="card">
  <div class="k">观测主机</div>
  <div class="v">${host.cpus||'-'} 核</div>
  <p class="small">load ${(host.loadavg||[]).map(x=>Number(x).toFixed(2)).join(' / ') || '-'}</p>
  <p class="small">内存可用 ${fmtB((mem.available_kb||0)*1024)} / 总计 ${fmtB((mem.total_kb||0)*1024)}</p>
  <p class="small">根盘 ${fmtB((host.disk_root||{}).used_bytes)} / ${fmtB((host.disk_root||{}).size_bytes)}</p>
</div>`;

const regRows = (registry.runners||[]).map((r) => {
  const transport = r.transport || {};
  const t = transport.kind === 'wsl' ? ('wsl:' + (transport.distro||''))
    : transport.kind === 'ssh' ? ('ssh:' + (transport.user?transport.user+'@':'') + (transport.host||''))
    : 'local';
  return `<tr>
    <td>${esc(r.label)}</td>
    <td class="mono">${esc(t)}</td>
    <td class="mono">${esc(transport.path||'')}</td>
    <td>${esc(r.identity?.agentName||'-')} #${esc(r.identity?.agentId ?? '-')}</td>
    <td>${pill(r.state || (r.enabled===false?'disabled':'unknown'))}</td>
    <td>${esc(r.addedBy||'-')}</td>
    <td class="small">${esc(fmtTs(r.lastSeenAt))}</td>
  </tr>`;
}).join('');
const pendingRows = (registry.pending||[]).map((p) => `<tr>
    <td>${esc(p.label||'-')}</td>
    <td class="mono">${esc(p.transport?.kind||'')}</td>
    <td class="mono">${esc(p.path||'')}</td>
    <td>${esc(p.identity?.agentName||'-')} #${esc(p.identity?.agentId ?? '-')}</td>
    <td><span class="pill busy">pending</span></td>
    <td class="small">${esc(p.via||'')}</td>
    <td class="small">${esc(fmtTs(p.foundAt))}</td>
  </tr>`).join('');
$('registry').innerHTML =
  (regRows
    ? '<table><thead><tr><th>名称</th><th>类型</th><th>路径</th><th>身份</th><th>状态</th><th>来源</th><th>最近见到</th></tr></thead><tbody>' + regRows + '</tbody></table>'
    : '<p class="small">注册表为空。用 <code>runner_watcher_add</code> 导入，或 <code>runner_watcher_discover</code> 自动发现。</p>')
  + (pendingRows
    ? '<h2 style="margin-top:16px">待确认（发现但未接入）</h2><table><thead><tr><th>名称</th><th>类型</th><th>路径</th><th>身份</th><th>状态</th><th>发现方式</th><th>发现时间</th></tr></thead><tbody>'
      + pendingRows + '</tbody></table><p class="small">用 <code>runner_watcher_adopt</code> 接入，或用 <code>runner_watcher_discover --adopt</code> 一次性全部接入。</p>'
    : '');

const SERIES = {
  score: {label:'综合 RPS', color:'#7ee0c3', width:2.6, key:'score', on:true},
  reliability: {label:'可靠', color:'#7aa2ff', width:1.4, key:'reliability', on:true},
  speed: {label:'速度', color:'#ffc857', width:1.4, key:'speed', on:true},
  efficiency: {label:'效率', color:'#c084fc', width:1.4, key:'efficiency', on:false},
  stability: {label:'稳定', color:'#fb923c', width:1.4, key:'stability', on:false},
  job_score: {label:'当次任务分', color:'#94a3b8', width:1.2, key:'job_score', on:true, dash:[4,4]},
};
const runnerColors = ['#38bdf8','#f472b6','#a3e635','#e879f9','#fbbf24','#34d399'];
let ri = 0;
Object.keys(DATA.score_by_runner || {}).forEach((name) => {
  SERIES['runner:' + name] = {
    label: name,
    color: runnerColors[ri++ % runnerColors.length],
    width: 1.6,
    key: 'score',
    on: false,
    points: DATA.score_by_runner[name],
  };
});
$('legend').innerHTML = Object.entries(SERIES).map(([id,s]) =>
  `<label><input type="checkbox" data-id="${esc(id)}" ${s.on?'checked':''}/><i style="background:${s.color}"></i>${esc(s.label)}</label>`
).join('');
$('legend').addEventListener('change', (e) => {
  const id = e.target.getAttribute('data-id');
  if (id && SERIES[id]) { SERIES[id].on = e.target.checked; draw(); }
});

const points = (DATA.score_series||[]).filter((p) => p && p.ts);
const last = points.length ? points[points.length-1] : null;
$('scoreNow').textContent = last && last.score!=null
  ? ('当前 ' + last.score + ' ' + (last.grade || gradeOf(last.score)))
  : '暂无曲线';

function parseTs(ts) {
  if (!ts) return 0;
  const t = Date.parse(String(ts).replace(' ','T'));
  return isFinite(t) ? t : 0;
}
function fmtTs(ts) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return String(ts||'');
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

const canvas = $('trend');
const tip = $('tip');
const wrap = canvas.parentElement;
let hoverIdx = -1;

function layout() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  return { dpr, W, H, l: 46, r: 16, t: 18, b: 38 };
}
function xOf(i, n, L) {
  if (n <= 1) return L.l + (L.W - L.l - L.r) / 2;
  return L.l + i * (L.W - L.l - L.r) / (n - 1);
}
function yOf(v, L) {
  const c = Math.max(0, Math.min(100, Number(v) || 0));
  return L.t + (1 - c/100) * (L.H - L.t - L.b);
}
function xOfTs(ts, n, L) {
  if (n <= 1) return xOf(0, n, L);
  const t0 = parseTs(points[0].ts), t1 = parseTs(points[n-1].ts);
  const t = parseTs(ts);
  if (t1 === t0) return xOf(0, n, L);
  const r = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  return L.l + r * (L.W - L.l - L.r);
}

function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = wrap.clientWidth || 900;
  const h = wrap.clientHeight || 340;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  draw();
}

function draw() {
  const ctx = canvas.getContext('2d');
  const L = layout();
  ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  ctx.clearRect(0, 0, L.W, L.H);
  const n = points.length;

  const bands = [
    {y:90, c:'rgba(126,224,195,.08)'},
    {y:80, c:'rgba(61,214,140,.06)'},
    {y:70, c:'rgba(122,162,255,.05)'},
    {y:60, c:'rgba(255,200,87,.05)'},
    {y:50, c:'rgba(251,146,60,.05)'},
  ];
  ctx.fillStyle = 'rgba(15,23,42,.35)';
  ctx.fillRect(L.l, L.t, L.W-L.l-L.r, L.H-L.t-L.b);
  bands.forEach((b, i) => {
    const y1 = yOf(b.y, L);
    const y0 = i === 0 ? L.t : yOf(bands[i-1].y, L);
    ctx.fillStyle = b.c;
    ctx.fillRect(L.l, y0, L.W-L.l-L.r, Math.max(0, y1-y0));
  });

  ctx.strokeStyle = '#243049';
  ctx.lineWidth = 1;
  ctx.font = '11px "Segoe UI", sans-serif';
  for (const v of [0,50,60,70,80,90,100]) {
    const y = yOf(v, L);
    ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.W-L.r, y); ctx.stroke();
    ctx.fillStyle = '#93a0bf';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(String(v), L.l - 6, y);
  }

  if (!n) {
    ctx.fillStyle = '#93a0bf';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.fillText('暂无已完成任务 —— 先运行 collect', L.W/2, L.H/2);
    return;
  }

  const ticks = Math.min(6, n);
  ctx.fillStyle = '#93a0bf';
  ctx.font = '11px "Segoe UI", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = 0; t < ticks; t++) {
    const i = ticks === 1 ? 0 : Math.round(t*(n-1)/(ticks-1));
    ctx.fillText(fmtTs(points[i].ts), xOf(i, n, L), L.H - L.b + 8);
  }

  function strokeSeries(s) {
    const src = s.points || points;
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.setLineDash(s.dash || []);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    let started = false;
    if (s.points) {
      src.forEach((p) => {
        const v = p[s.key];
        if (v == null) { started = false; return; }
        const x = xOfTs(p.ts, n, L), y = yOf(v, L);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
    } else {
      for (let i = 0; i < n; i++) {
        const v = points[i][s.key];
        if (v == null) { started = false; continue; }
        const x = xOf(i, n, L), y = yOf(v, L);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  Object.values(SERIES).forEach((s) => { if (s.on) strokeSeries(s); });

  if (SERIES.score.on) {
    for (let i = 0; i < n; i++) {
      if (points[i].score == null) continue;
      const x = xOf(i, n, L), y = yOf(points[i].score, L);
      ctx.beginPath();
      ctx.fillStyle = (points[i].result === 'Succeeded' || points[i].result === 'Success') ? '#7ee0c3' : '#ff6b7a';
      ctx.arc(x, y, i === hoverIdx ? 5 : 3, 0, Math.PI*2);
      ctx.fill();
    }
  }

  if (hoverIdx >= 0 && hoverIdx < n) {
    const x = xOf(hoverIdx, n, L);
    ctx.strokeStyle = 'rgba(232,238,252,.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(x, L.t); ctx.lineTo(x, L.H-L.b); ctx.stroke();
    ctx.setLineDash([]);
    const p = points[hoverIdx];
    if (p.score != null) {
      ctx.beginPath();
      ctx.strokeStyle = '#e8eefc';
      ctx.arc(x, yOf(p.score, L), 7, 0, Math.PI*2);
      ctx.stroke();
    }
  }
}

function nearest(mx) {
  const L = layout();
  const n = points.length;
  if (!n) return -1;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(xOf(i, n, L) - mx);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD < 48 ? best : -1;
}

function showTip(idx, clientX, clientY) {
  if (idx < 0) { tip.style.display = 'none'; return; }
  const p = points[idx];
  const ok = p.result === 'Succeeded' || p.result === 'Success';
  tip.innerHTML =
    '<div class="muted">' + esc(fmtTs(p.ts)) + ' · 窗口 ' + esc(p.n ?? '-') + ' 次</div>' +
    '<div><b>RPS ' + fmtN(p.score) + '</b> ' + gradePill(p.grade || gradeOf(p.score)) + '</div>' +
    '<div>可靠 ' + fmtN(p.reliability) + ' · 速度 ' + fmtN(p.speed) + '</div>' +
    '<div>效率 ' + fmtN(p.efficiency) + ' · 稳定 ' + fmtN(p.stability) + '</div>' +
    '<div style="margin-top:6px">当次 ' + esc(p.job||'') + ' ' + (ok ? '<span class="pill ok">成功</span>' : '<span class="pill bad">'+esc(p.result||'?')+'</span>') + '</div>' +
    '<div class="muted">任务分 ' + fmtN(p.job_score) + ' · 耗时 ' + fmtS(p.duration_sec) + ' · ' + esc(p.runner||'') + '</div>';
  tip.style.display = 'block';
  const rect = wrap.getBoundingClientRect();
  let left = clientX - rect.left + 14;
  let top = clientY - rect.top - 10;
  const tw = 260, th = 130;
  if (left + tw > rect.width) left = clientX - rect.left - tw - 10;
  if (top + th > rect.height) top = rect.height - th - 8;
  if (top < 8) top = 8;
  if (left < 8) left = 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const idx = nearest(e.clientX - rect.left);
  if (idx !== hoverIdx) { hoverIdx = idx; draw(); }
  showTip(idx, e.clientX, e.clientY);
});
canvas.addEventListener('mouseleave', () => { hoverIdx = -1; draw(); tip.style.display = 'none'; });
window.addEventListener('resize', resize);
resize();

const names = DATA.job_names||[];
$('names').innerHTML = '<table><thead><tr><th>任务</th><th>次数</th><th>RPS</th><th>等级</th><th>成功率</th><th>P50</th><th>P95</th><th>任务均分</th><th>难度</th></tr></thead><tbody>'
  + names.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.count}</td><td>${fmtN(x.rps)}</td><td>${gradePill(x.grade)}</td><td>${(x.success_rate*100).toFixed(1)}%</td><td>${fmtS(x.duration_p50)}</td><td>${fmtS(x.duration_p95)}</td><td>${fmtN(x.job_score_avg)}</td><td>${x.difficulty_avg}</td></tr>`).join('')
  + '</tbody></table>';

const jobs = DATA.jobs||[];
$('jobs').innerHTML = '<table><thead><tr><th>开始</th><th>Runner</th><th>任务</th><th>结果</th><th>耗时</th><th>任务分</th><th>可靠</th><th>速度</th><th>效率</th><th>稳定</th><th>难度</th></tr></thead><tbody>'
  + jobs.slice(0,80).map((j) => `<tr><td class="mono">${esc(fmtTs(j.started))}</td><td>${esc(j.runner||'')}</td><td>${esc(j.name||'')}</td><td>${resPill(j.result)}</td><td>${fmtS(j.duration_sec)}</td><td>${fmtN(j.job_score)} ${gradePill(j.job_grade)}</td><td>${fmtN(j.reliability,0)}</td><td>${fmtN(j.speed_score,0)}</td><td>${fmtN(j.efficiency,0)}</td><td>${fmtN(j.stability,0)}</td><td>${j.difficulty ?? '-'}</td></tr>`).join('')
  + '</tbody></table>';

// Near-real-time status: poll the server's pre-refreshed cache and patch the
// runner cards in place. Nothing here ever reloads the page, and a failed or
// hidden tick simply keeps what is on screen.
const LIVE_MS = Math.max(3, Number(DATA.liveIntervalSec || 0)) * 1000;
const liveTs = $('live-ts');
function applyLive(live) {
  for (const r of (live && live.runners) || []) {
    const root = document.querySelector('[data-live-id="' + CSS.escape(String(r.id)) + '"]');
    if (!root) continue;
    const stateEl = root.querySelector('[data-live="state"]');
    if (stateEl) stateEl.innerHTML = pill(r.state || 'unknown');
    const jobEl = root.querySelector('[data-live="job"]');
    if (jobEl) jobEl.textContent = (r.state === 'busy' && r.job) ? ('当前任务 ' + r.job) : '空闲';
    const memEl = root.querySelector('[data-live="mem"]');
    if (memEl && r.memCurrent != null) memEl.textContent = 'cgroup 内存 ' + fmtB(r.memCurrent) + ' / 峰值 ' + fmtB(r.memPeak ?? 0);
  }
  if (liveTs && live && live.ts) liveTs.textContent = '· 状态更新于 ' + fmtTs(live.ts);
}
if (LIVE_MS > 0) {
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const res = await fetch('api/live', { cache: 'no-store' });
      if (!res.ok) return;
      applyLive(await res.json());
    } catch { /* keep the previous state on screen */ }
  }, LIVE_MS);
}
</script>
</body>
</html>
