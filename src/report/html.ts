// Single-file HTML report (no external libraries). Built for a screen recording:
// headline, pipeline counts, metric comparison, a featured example, and click-through lineage.

import type { RunResult } from '../pipeline.js';
import { SCENARIOS } from '../synth/scenarios.js';
import { formatWall, localYear } from '../util/time.js';
import type { SourceRecord } from '../types.js';

function pickExample(r: RunResult): string | undefined {
  // A request that reached the plan through 2+ channels, ideally with a repaired fax read and a decision.
  const score = (c: (typeof r.rec.cases)[number]) => {
    const subs = c.records.filter((x) => r.rec.byRef.get(x)?.kind === 'submission');
    const chans = new Set(subs.map((x) => x.split(':')[0]));
    let s = chans.size * 10 + (c.decision ? 3 : 0) + (c.conflicts.length ? 2 : 0);
    if (subs.some((x) => r.rec.byRef.get(x)?.issues.some((i) => /repaired|recovered/.test(i)))) s += 4;
    if (c.appeals.length) s += 1;
    return s;
  };
  const inYear = (t?: number) => t !== undefined && localYear(t) === r.year;
  return [...r.rec.cases].filter((c) => inYear(c.decidedAt)).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0]?.id;
}

function recordView(x: SourceRecord) {
  return {
    ref: x.ref,
    ch: x.channel,
    kind: x.kind,
    member: x.memberIdRaw && x.memberIdRaw !== x.memberId ? `${x.memberId} (read as ${x.memberIdRaw})` : x.memberId,
    cpt: x.cpt,
    pri: x.priority,
    recv: x.receivedAt !== undefined ? formatWall(x.receivedAt) : undefined,
    dec: x.decision ?? (x.withdrawn ? 'withdrawn' : x.closedDuplicate ? 'closed as duplicate' : undefined),
    decAt: x.decidedAt !== undefined ? formatWall(x.decidedAt) : undefined,
    auth: x.authNumber,
    conf: x.confidence,
    issues: x.issues,
  };
}

export function renderReport(r: RunResult): string {
  const rec = r.rec;
  const records: Record<string, ReturnType<typeof recordView>> = {};
  for (const x of rec.byRef.values()) if (x.kind !== 'inquiry') records[x.ref] = recordView(x);
  const appeals = Object.fromEntries(
    rec.appeals.map((a) => [a.ref, { ref: a.ref, recv: formatWall(a.receivedAt), outcome: a.outcome ?? 'pending', decAt: a.decidedAt ? formatWall(a.decidedAt) : undefined, auth: a.authNumber, issues: a.issues }]),
  );
  const cases = rec.cases.map((c) => ({
    id: c.id,
    recv: formatWall(c.receivedAt),
    pri: c.priority,
    dec: c.withdrawn ? 'withdrawn' : c.decision ?? 'pending',
    decAt: c.decidedAt ? formatWall(c.decidedAt) : undefined,
    hrs: c.decidedAt ? Math.round(((c.decidedAt - c.receivedAt) / 3_600_000) * 10) / 10 : undefined,
    ext: c.extended,
    member: c.memberId,
    cpt: c.cpt,
    src: c.decisionSource,
    records: c.records,
    appeals: c.appeals,
    conflicts: c.conflicts,
    review: c.needsReview,
  }));
  const byChannel: Record<string, { sub: number; dec: number }> = { fhir: { sub: 0, dec: 0 }, portal: { sub: 0, dec: 0 }, fax: { sub: 0, dec: 0 }, phone: { sub: 0, dec: 0 } };
  for (const x of rec.byRef.values()) {
    if (x.kind === 'submission') byChannel[x.channel].sub++;
    if (x.kind === 'decision') byChannel[x.channel].dec++;
  }
  const naiveTotal = r.naive.metrics.filter((m) => m.key.endsWith('.total')).reduce((s, m) => s + (m.value ?? 0), 0);
  const recTotal = r.reconciled.metrics.filter((m) => m.key.endsWith('.total')).reduce((s, m) => s + (m.value ?? 0), 0);
  const truthTotal = r.truth?.metrics.filter((m) => m.key.endsWith('.total')).reduce((s, m) => s + (m.value ?? 0), 0);
  const data = {
    name: r.name,
    title: r.title,
    description: r.description,
    year: r.year,
    counts: r.counts,
    byChannel,
    totals: { naive: naiveTotal, rec: recTotal, truth: truthTotal },
    metrics: r.reconciled.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      unit: m.unit,
      def: m.definition,
      rec: m.value,
      recNum: m.numerator,
      recDen: m.denominator,
      ids: m.ids,
      naive: r.naive.metrics.find((n) => n.key === m.key)?.value ?? null,
      truth: r.truth?.metrics.find((n) => n.key === m.key)?.value ?? null,
    })),
    cases,
    records,
    appeals,
    review: rec.review,
    evaluation: r.evaluation,
    example: pickExample(r),
    scenarios: SCENARIOS.map((s) => ({ name: s.name, title: s.title, short: SHORT[s.name] ?? s.name })),
    warnings: r.warnings.slice(0, 50),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PA Reconciler: ${escapeHtml(r.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="brand"><span class="dot"></span>Prior Auth Metrics Reconciler</div>
  <nav id="nav"></nav>
</header>
<main>
  <section class="hero">
    <p class="eyebrow">CMS-0057-F annual prior authorization metrics &middot; reporting year ${r.year} &middot; synthetic data, no PHI</p>
    <h1 id="title"></h1>
    <p class="lede" id="desc"></p>
    <div class="headline" id="headline"></div>
  </section>

  <section>
    <h2>1. Four channels in, one count out</h2>
    <div class="pipeline" id="pipeline"></div>
  </section>

  <section>
    <h2>2. One request, seen by several systems</h2>
    <p class="hint">Picked automatically: a request that arrived on more than one channel. This is what gets double counted when each channel reports on its own.</p>
    <div id="example"></div>
  </section>

  <section>
    <h2>3. The metrics CMS asks for</h2>
    <p class="hint">Naive = add up each channel's own report. Reconciled = this tool. Answer key = what really happened (synthetic scenarios only). Click a row to see the requests behind the number.</p>
    <div class="tablewrap"><table id="metrics"></table></div>
    <div id="drill"></div>
  </section>

  <section>
    <h2>4. Human review queue</h2>
    <p class="hint">The tool never silently guesses. Every disagreement between channels, unreadable fax field or unlinked record lands here with the records attached.</p>
    <div id="review"></div>
  </section>

  <section id="evalsec">
    <h2>5. How accurate is the matching?</h2>
    <div id="eval"></div>
  </section>

  <section>
    <h2>Look up any request</h2>
    <input id="search" placeholder="Case ID (C00012), record (fax:FX-000031), member ID or auth number" autocomplete="off">
    <div id="lookup"></div>
  </section>
</main>
<footer>Synthetic scenario generated by this project. Metric definitions follow the CMS Prior Authorization Metrics Reporting Overview template. Period basis: determination date in the payer's time zone (America/New_York).</footer>
<script type="application/json" id="data">${json}</script>
<script>${JS}</script>
</body>
</html>
`;
}

const SHORT: Record<string, string> = {
  '01-clean': 'Clean',
  '02-double-entry': 'Resubmits',
  '03-ocr-noise': 'OCR noise',
  '04-conflicts': 'Conflicts',
  '05-appeals-extensions': 'Appeals',
  '06-year-boundary': 'Year end',
  '07-realistic': 'Realistic',
  '08-look-alikes': 'Look-alikes',
};

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const CSS = `
:root{--bg:#f7f6f2;--panel:#ffffff;--ink:#1d2330;--muted:#5e6676;--line:#e2e0d8;--accent:#0f6e6e;--accent-soft:#e1f0ef;--warn:#a2461b;--warn-soft:#fbeae1;--good:#2d6a2f;--good-soft:#e5f1e4;--fhir:#3b5bb5;--portal:#0f6e6e;--fax:#a2461b;--phone:#7a4bb0;--mono:ui-monospace,SFMono-Regular,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--panel:#1a1e26;--ink:#e7e9ee;--muted:#9aa2b1;--line:#2b313c;--accent:#4fc1b9;--accent-soft:#163331;--warn:#f0956a;--warn-soft:#3a2219;--good:#86c98a;--good-soft:#1b2e1c;--fhir:#8aa4f0;--portal:#4fc1b9;--fax:#f0956a;--phone:#c19af0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5;flex-wrap:wrap}
.brand{font-weight:650;display:flex;align-items:center;gap:8px}.dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
nav{display:flex;gap:6px;flex-wrap:wrap}nav a{font-size:13px;color:var(--muted);text-decoration:none;padding:4px 8px;border-radius:6px;border:1px solid var(--line)}nav a.on{background:var(--accent);color:var(--panel);border-color:var(--accent)}
main{max-width:1100px;margin:0 auto;padding:16px 24px 48px}section{margin:28px 0}
.eyebrow{color:var(--muted);font-size:13px;margin:0 0 4px}h1{font-size:30px;margin:0 0 6px;letter-spacing:-.01em}h2{font-size:19px;margin:0 0 8px}.lede{color:var(--muted);max-width:760px;margin:0 0 16px}.hint{color:var(--muted);font-size:13.5px;margin:0 0 12px;max-width:820px}
.headline{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.stat .v{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums}.stat .l{color:var(--muted);font-size:13px}.stat.bad .v{color:var(--warn)}.stat.ok .v{color:var(--good)}
.pipeline{display:grid;grid-template-columns:1.2fr auto 1fr auto 1fr;gap:12px;align-items:center}
.chans{display:grid;gap:8px}.chan{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--c);border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;gap:8px;font-size:14px}.chan b{font-variant-numeric:tabular-nums}
.arrow{color:var(--muted);font-size:22px;text-align:center}
.box{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.box .v{font-size:26px;font-weight:650}.box .l{color:var(--muted);font-size:13px}.box ul{margin:8px 0 0;padding-left:18px;color:var(--muted);font-size:13px}
.badge{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 7px;border-radius:999px;background:var(--c);color:var(--panel);text-transform:uppercase;letter-spacing:.03em}
.c-fhir{--c:var(--fhir)}.c-portal{--c:var(--portal)}.c-fax{--c:var(--fax)}.c-phone{--c:var(--phone)}.c-appeal{--c:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}.card h3{margin:0 0 4px;font-size:17px}.kv{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13.5px;color:var(--muted);margin-bottom:12px}.kv b{color:var(--ink);font-weight:600}
.timeline{display:grid;gap:8px}.rec{border:1px solid var(--line);border-left:4px solid var(--c);border-radius:8px;padding:8px 12px;font-size:13.5px}.rec .row{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center}.rec code{font-family:var(--mono);font-size:12.5px}.issue{color:var(--warn);font-size:12.5px;margin-top:4px}
.conf{background:var(--warn-soft);color:var(--warn);border-radius:8px;padding:8px 12px;font-size:13.5px;margin-top:10px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}th:first-child,td:first-child{text-align:left;white-space:normal}th{font-size:12.5px;color:var(--muted);font-weight:600;background:var(--bg)}
tbody tr{cursor:pointer}tbody tr:hover{background:var(--accent-soft)}tr.sel{background:var(--accent-soft)}
.off{color:var(--warn);font-weight:600}.on{color:var(--good)}.delta{font-size:12px;color:var(--muted)}
#drill{margin-top:12px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{font-family:var(--mono);font-size:12.5px;border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:3px 7px;cursor:pointer;color:var(--ink)}.chip:hover{border-color:var(--accent)}
.rq{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:12px}.rq .stat{cursor:pointer}.rq .stat.sel{outline:2px solid var(--accent)}
.rqlist{display:grid;gap:6px;max-height:340px;overflow:auto}.rqi{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13.5px;cursor:pointer}.rqi:hover{border-color:var(--accent)}
input#search{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font-size:15px;margin-bottom:12px}
footer{max-width:1100px;margin:0 auto;padding:0 24px 32px;color:var(--muted);font-size:12.5px}
@media (max-width:760px){.pipeline{grid-template-columns:1fr}.arrow{transform:rotate(90deg)}main{padding:12px 16px 40px}}
`;

const JS = `
const D = JSON.parse(document.getElementById('data').textContent);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const caseById = Object.fromEntries(D.cases.map((c) => [c.id, c]));
const fmt = (v, u) => v === null || v === undefined ? '&ndash;' : u === '%' ? v.toFixed(1) + '%' : u === 'hours' ? v.toFixed(1) + ' h' : v.toLocaleString();
const chName = {fhir:'FHIR API', portal:'Portal', fax:'Fax', phone:'Phone'};

$('nav').innerHTML = D.scenarios.map((s) => '<a href="../' + s.name + '/report.html" class="' + (s.name === D.name ? 'on' : '') + '" title="' + esc(s.title) + '">' + s.name.slice(0, 2) + ' ' + esc(s.short) + '</a>').join('');
$('title').textContent = D.title;
$('desc').textContent = D.description;

// headline
const T = D.totals;
const over = T.naive - (T.truth ?? T.rec);
const sm = D.metrics.find((m) => m.key === 'standard.medianHours');
let h = '';
h += '<div class="stat ' + (over > 0 ? 'bad' : '') + '"><div class="v">' + T.naive.toLocaleString() + '</div><div class="l">requests decided in ' + D.year + ' if each channel reports separately</div></div>';
h += '<div class="stat ok"><div class="v">' + T.rec.toLocaleString() + '</div><div class="l">requests decided in ' + D.year + ' after reconciliation' + (T.truth !== undefined ? ' (answer key: ' + T.truth.toLocaleString() + ')' : '') + '</div></div>';
if (sm && sm.naive !== null && sm.rec !== null) h += '<div class="stat ' + (Math.abs(sm.naive - sm.rec) >= 1 ? 'bad' : '') + '"><div class="v">' + sm.naive.toFixed(1) + ' h &rarr; ' + sm.rec.toFixed(1) + ' h</div><div class="l">standard median time to decision, naive &rarr; reconciled</div></div>';
if (D.counts.utcYearShift) h += '<div class="stat bad"><div class="v">' + D.counts.utcYearShift + '</div><div class="l">decisions that switch calendar year if timestamps are read as UTC instead of Eastern</div></div>';
h += '<div class="stat"><div class="v">' + D.counts.reviewItems.toLocaleString() + '</div><div class="l">items sent to human review</div></div>';
$('headline').innerHTML = h;

// pipeline
const chans = Object.entries(D.byChannel).map(([k, v]) => '<div class="chan c-' + k + '"><span>' + chName[k] + '</span><span><b>' + v.sub + '</b> requests &middot; ' + v.dec + ' decision notices</span></div>').join('');
$('pipeline').innerHTML = '<div class="chans">' + chans + '<div class="chan c-phone" style="opacity:.7"><span>Status calls</span><span><b>' + D.counts.inquiries + '</b> ignored, not requests</span></div><div class="chan c-appeal"><span>Appeals log</span><span><b>' + D.counts.appeals + '</b> appeals</span></div></div>'
 + '<div class="arrow">&rarr;</div><div class="box"><div class="v">' + D.counts.records.toLocaleString() + '</div><div class="l">source records parsed</div><ul><li>fax OCR repaired and validated</li><li>time zones normalized</li><li>decisions attached by auth # / fax ref</li></ul></div>'
 + '<div class="arrow">&rarr;</div><div class="box"><div class="v">' + D.counts.cases.toLocaleString() + '</div><div class="l">real requests, all dates (includes pending, withdrawn and other years)</div><ul><li>matched across channels</li><li>earliest receipt = clock start</li><li>' + D.counts.reviewItems + ' flagged for review</li></ul></div>';

function recordHtml(ref) {
  const r = D.records[ref];
  if (!r) { const a = D.appeals[ref]; if (!a) return ''; return '<div class="rec c-appeal"><div class="row"><span class="badge c-appeal">appeal</span><code>' + esc(a.ref) + '</code><span>received ' + esc(a.recv) + '</span><span>outcome <b>' + esc(a.outcome) + '</b>' + (a.decAt ? ' on ' + esc(a.decAt) : '') + '</span>' + (a.auth ? '<span>auth ' + esc(a.auth) + '</span>' : '') + '</div>' + a.issues.map((i) => '<div class="issue">' + esc(i) + '</div>').join('') + '</div>'; }
  const kind = r.kind === 'submission' ? 'request' : 'decision notice';
  return '<div class="rec c-' + r.ch + '"><div class="row"><span class="badge c-' + r.ch + '">' + chName[r.ch] + '</span><span>' + kind + '</span><code>' + esc(r.ref) + '</code>'
    + (r.recv ? '<span>received ' + esc(r.recv) + '</span>' : '')
    + (r.member ? '<span>member ' + esc(r.member) + '</span>' : '')
    + (r.cpt ? '<span>service ' + esc(r.cpt) + '</span>' : '')
    + (r.pri && r.kind === 'submission' ? '<span>' + esc(r.pri) + '</span>' : '')
    + (r.dec ? '<span><b>' + esc(r.dec) + '</b>' + (r.decAt ? ' ' + esc(r.decAt) : '') + '</span>' : '')
    + (r.auth ? '<span>auth ' + esc(r.auth) + '</span>' : '')
    + (r.conf < 1 ? '<span>confidence ' + r.conf.toFixed(2) + '</span>' : '')
    + '</div>' + r.issues.map((i) => '<div class="issue">' + esc(i) + '</div>').join('') + '</div>';
}
function caseHtml(id) {
  const c = caseById[id]; if (!c) return '<p class="hint">Not found.</p>';
  const recs = [...c.records].sort((a, b) => (D.records[a]?.recv || D.records[a]?.decAt || '').localeCompare(D.records[b]?.recv || D.records[b]?.decAt || ''));
  return '<div class="card"><h3>Request ' + esc(c.id) + '</h3><div class="kv">'
    + '<span>clock starts <b>' + esc(c.recv) + '</b> (earliest receipt)</span><span>priority <b>' + esc(c.pri) + '</b></span><span>decision <b>' + esc(c.dec) + '</b>' + (c.decAt ? ' ' + esc(c.decAt) : '') + '</span>'
    + (c.hrs !== undefined ? '<span>time to decision <b>' + c.hrs + ' h</b></span>' : '') + (c.ext ? '<span><b>review extended</b></span>' : '')
    + '<span>member <b>' + esc(c.member) + '</b></span><span>service <b>' + esc(c.cpt) + '</b></span>' + (c.src ? '<span>decision taken from <b>' + esc(c.src) + '</b></span>' : '') + '</div>'
    + '<div class="timeline">' + recs.map(recordHtml).join('') + c.appeals.map(recordHtml).join('') + '</div>'
    + c.conflicts.map((x) => '<div class="conf">Conflict sent to review: ' + esc(x) + '</div>').join('') + '</div>';
}
$('example').innerHTML = D.example ? caseHtml(D.example) : '<p class="hint">No multi-channel request in this scenario.</p>';

// metrics table
const hasTruth = D.metrics.some((m) => m.truth !== null);
const close = (a, b, u) => a !== null && b !== null && Math.abs(a - b) <= (u === 'count' ? 0 : u === 'hours' ? 0.5 : 0.2);
let t = '<thead><tr><th>Metric</th><th>Naive (sum of channels)</th><th>Reconciled</th>' + (hasTruth ? '<th>Answer key</th>' : '') + '</tr></thead><tbody>';
for (const m of D.metrics) {
  const nCls = hasTruth ? (close(m.naive, m.truth, m.unit) ? 'on' : 'off') : '';
  const rCls = hasTruth ? (close(m.rec, m.truth, m.unit) ? 'on' : 'off') : '';
  t += '<tr data-k="' + m.key + '" title="' + esc(m.def) + '"><td>' + esc(m.label) + '</td><td class="' + nCls + '">' + fmt(m.naive, m.unit) + '</td><td class="' + rCls + '">' + fmt(m.rec, m.unit) + (m.recDen !== undefined ? ' <span class="delta">' + m.recNum + '/' + m.recDen + '</span>' : '') + '</td>' + (hasTruth ? '<td>' + fmt(m.truth, m.unit) + '</td>' : '') + '</tr>';
}
$('metrics').innerHTML = t + '</tbody>';
$('metrics').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-k]'); if (!tr) return;
  document.querySelectorAll('#metrics tr').forEach((x) => x.classList.remove('sel')); tr.classList.add('sel');
  const m = D.metrics.find((x) => x.key === tr.dataset.k);
  const ids = m.ids;
  $('drill').innerHTML = '<div class="card"><h3>' + esc(m.label) + '</h3><p class="hint">' + esc(m.def) + '. ' + ids.length + ' items behind the reconciled number. Click one to see its source records.</p><div class="chips">' + ids.slice(0, 300).map((i) => '<button class="chip" data-id="' + esc(i) + '">' + esc(i) + '</button>').join('') + (ids.length > 300 ? '<span class="hint">&hellip; and ' + (ids.length - 300) + ' more (see cases.csv)</span>' : '') + '</div><div id="drillcase" style="margin-top:12px"></div></div>';
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  let id = b.dataset.id;
  if (!caseById[id]) { const c = D.cases.find((c) => c.appeals.includes(id) || c.records.includes(id)); if (c) id = c.id; }
  const host = b.closest('.card').querySelector('#drillcase') || $('lookup');
  host.innerHTML = caseHtml(id);
});

// review queue
const groups = {};
for (const r of D.review) (groups[r.type] = groups[r.type] || []).push(r);
const label = {'decision-conflict':'Channels disagree on the decision','priority-conflict':'Channels disagree on priority','possible-duplicate':'Possible duplicate, not merged','orphan-decision':'Decision with no matching request','unlinked-appeal':'Appeal with no matching denial','low-confidence':'Fax fields unreadable','missing-receipt-time':'No receipt time'};
const keys = Object.keys(groups);
$('review').innerHTML = keys.length ? '<div class="rq">' + keys.map((k) => '<div class="stat" data-g="' + k + '"><div class="v">' + groups[k].length + '</div><div class="l">' + (label[k] || k) + '</div></div>').join('') + '</div><div class="rqlist" id="rqlist"></div>' : '<p class="hint">Nothing to review in this scenario.</p>';
function showGroup(k) {
  document.querySelectorAll('.rq .stat').forEach((x) => x.classList.toggle('sel', x.dataset.g === k));
  $('rqlist').innerHTML = groups[k].slice(0, 200).map((r) => '<div class="rqi" data-c="' + esc(r.caseId || '') + '" data-r="' + esc(r.refs[0]) + '">' + (r.caseId ? '<b>' + esc(r.caseId) + '</b> ' : '') + esc(r.message) + '</div>').join('');
}
if (keys.length) { showGroup(keys[0]); document.querySelector('.rq').addEventListener('click', (e) => { const s = e.target.closest('[data-g]'); if (s) showGroup(s.dataset.g); }); }
document.addEventListener('click', (e) => {
  const it = e.target.closest('.rqi'); if (!it) return;
  let id = it.dataset.c; if (!id) { const c = D.cases.find((c) => c.records.includes(it.dataset.r)); id = c && c.id; }
  $('search').value = id || it.dataset.r; doLookup(); $('search').scrollIntoView({behavior:'smooth'});
});

// evaluation
if (D.evaluation) {
  const E = D.evaluation;
  const p = (x) => x === null ? '&ndash;' : (x * 100).toFixed(1) + '%';
  $('eval').innerHTML = '<div class="headline">'
    + '<div class="stat"><div class="v">' + p(E.pairPrecision) + '</div><div class="l">merge precision: of records merged together, share that truly belong together</div></div>'
    + '<div class="stat"><div class="v">' + p(E.pairRecall) + '</div><div class="l">merge recall: of records that belong together, share merged</div></div>'
    + '<div class="stat"><div class="v">' + p(E.exactRequestAccuracy) + '</div><div class="l">requests rebuilt exactly (' + E.falseMerges + ' wrong merges, ' + E.missedMerges + ' missed)</div></div>'
    + '<div class="stat"><div class="v">' + p(E.appealLinkAccuracy) + '</div><div class="l">appeals linked to the right request</div></div>'
    + '</div><p class="hint" style="margin-top:10px">Fax extraction accuracy on ' + E.faxPagesScored + ' pages: ' + Object.entries(E.faxFieldAccuracy).map(([k, v]) => k + ' ' + p(v)).join(' &middot; ') + '</p>';
} else $('evalsec').style.display = 'none';

// lookup
function doLookup() {
  const q = $('search').value.trim().toUpperCase(); if (!q) { $('lookup').innerHTML = ''; return; }
  let c = caseById[q] || D.cases.find((c) => c.records.some((r) => r.toUpperCase() === q || r.toUpperCase().endsWith(':' + q)) || c.appeals.some((a) => a.toUpperCase().endsWith(q)));
  if (!c) c = D.cases.find((c) => c.records.some((r) => (D.records[r]?.auth || '').toUpperCase() === q));
  const list = !c ? D.cases.filter((x) => (x.member || '').toUpperCase() === q) : [];
  $('lookup').innerHTML = c ? caseHtml(c.id) : list.length ? '<div class="timeline">' + list.map((x) => caseHtml(x.id)).join('') + '</div>' : '<p class="hint">No match.</p>';
}
$('search').addEventListener('input', doLookup);
`;
