/**
 * One-page briefs: a printable A4 page per road for an official's desk,
 * built from everything the service knows about that road: now against
 * typical and night, the next two hours, the rush and what helps, the
 * week's chart, how far the figures can be trusted (second source, timed
 * drives, formal-use status), rain, and any evaluated changes. Always
 * light, always print-ready; findings not fit for formal use say so on the
 * page itself.
 */
import { agreementText } from './crosscheck.mjs';
import { groundTruthText } from './drives.mjs';
import { skillText } from './forecast.mjs';
import { rainText } from './raineffect.mjs';
import { impactText } from './impact.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const m = (v) => (v == null ? '—' : `${Math.round(v)} min`);
const ist = (iso, len = 16) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, len).replace('T', ' ');
const LEVEL = { clear: '#1e8449', busy: '#b7950b', heavy: '#d35400', jammed: '#c0392b', unknown: '#7f8c8d' };

/** A compact week chart: live drive (blue), night-time drive (green); days marked. */
function weekChart(totals, night, { width = 680, height = 150 } = {}) {
  const pts = totals.filter((r) => r.travel_s != null);
  if (pts.length < 2) return '<p class="muted">Not enough readings for a chart yet.</p>';
  const t0 = Date.parse(pts[0].ts), t1 = Date.parse(pts[pts.length - 1].ts);
  const vals = pts.map((r) => r.travel_s / 60);
  const max = Math.max(...vals) * 1.08, min = Math.min(...vals, night ?? Infinity) * 0.9;
  const x = (ts) => 34 + ((Date.parse(ts) - t0) / (t1 - t0 || 1)) * (width - 44);
  const y = (v) => 6 + (1 - (v - min) / (max - min || 1)) * (height - 26);
  const path = pts.map((r, i) => `${i ? 'L' : 'M'}${x(r.ts).toFixed(1)},${y(r.travel_s / 60).toFixed(1)}`).join(' ');
  const days = [];
  for (let d = Math.ceil((t0 + 330 * 60_000) / 86_400_000) * 86_400_000 - 330 * 60_000; d < t1; d += 86_400_000) {
    const ts = new Date(d).toISOString();
    days.push(`<line x1="${x(ts)}" x2="${x(ts)}" y1="6" y2="${height - 20}" stroke="#ddd"/><text x="${x(ts) + 2}" y="${height - 6}" font-size="10" fill="#777">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(d + 330 * 60_000).getUTCDay()]}</text>`);
  }
  const grid = [min, (min + max) / 2, max].map((v) => `<text x="2" y="${y(v) + 3}" font-size="10" fill="#777">${Math.round(v)}</text>`).join('');
  const base = night ? `<line x1="34" x2="${width - 10}" y1="${y(night)}" y2="${y(night)}" stroke="#1e8449" stroke-dasharray="4 3"/>` : '';
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="drive minutes over the last seven days">${days.join('')}${grid}${base}<path d="${path}" fill="none" stroke="#1a5fb4" stroke-width="1.4"/></svg><p class="muted small">Minutes for the whole road over the last seven days (blue); night-time drive (green dashes).</p>`;
}

/** One road's brief section (a printed page). */
export function briefSection({ insight, totals, forecast, skill, rain, impacts = [], names = {}, generatedAt }) {
  const r = insight, c = r.corridor, st = r.status;
  const formal = r.formal?.ready;
  const tips = (r.tips || []).filter((t) => ['rush', 'calm', 'shift', 'no-shift', 'bottleneck', 'spread'].includes(t.kind));
  return `<section class="page">
<header><div><h1>${esc(c.name)}</h1><p class="muted">${c.lengthKm} km · ${(c.definition?.sections || []).length} stretches · brief generated ${esc(ist(generatedAt))} IST</p></div>
<div class="status ${formal ? 'ok' : 'warn'}">${formal ? 'Fit for formal use' : 'Not yet for formal use'}<span>${esc(formal ? `${r.confidence?.text || ''}; confirmed against Google` : (r.formal?.text || '').replace(/^Not yet: /, ''))}</span></div></header>
<div class="tiles">
<div><span>Now${st ? ` (${esc(ist(st.ts).slice(11))})` : ''}</span><b style="color:${LEVEL[st?.level || 'unknown']}">${m(st?.minutes)}</b><em>${esc(st?.level || '')}${st?.unusual ? ' · unusual for this time' : ''}</em></div>
<div><span>Typical at this time</span><b>${m(st?.usualMinutes)}</b><em>${st?.usualRange ? `${Math.round(st.usualRange[0])}–${Math.round(st.usualRange[1])} most days` : ''}</em></div>
<div><span>Night-time drive</span><b>${m(r.baseline?.minutes ?? st?.nightMinutes)}</b><em>the reference for delay</em></div>
<div><span>In two hours</span><b>${m(forecast?.list?.find((f) => f.horizon === 120)?.minutes)}</b><em>${forecast?.list?.find((f) => f.horizon === 120) ? `${Math.round(forecast.list.find((f) => f.horizon === 120).low)}–${Math.round(forecast.list.find((f) => f.horizon === 120).high)} expected` : 'no forecast yet'}</em></div>
</div>
<h2>Next two hours</h2>
${forecast?.list?.length ? `<table><tr><th>Leaving at</th>${forecast.list.map((f) => `<th>${esc(ist(f.target_ts).slice(11))}</th>`).join('')}</tr><tr><td>Expected</td>${forecast.list.map((f) => `<td>${m(f.minutes)}</td>`).join('')}</tr><tr><td>Range</td>${forecast.list.map((f) => `<td>${Math.round(f.low)}–${Math.round(f.high)}</td>`).join('')}</tr></table><p class="muted small">Track record: ${esc(skillText(skill, 60))}.</p>` : '<p class="muted">Forecasts start once each half-hour has been recorded at least once.</p>'}
<h2>The rush and what helps</h2>
${tips.length ? `<ul>${tips.map((t) => `<li>${esc(t.text)}</li>`).concat((r.notes || []).map((n) => `<li>${esc(n)}</li>`)).join('')}</ul>` : '<p class="muted">Rush-hour findings appear once each half-hour has been recorded on two weekdays.</p>'}
<h2>Last seven days</h2>
${weekChart(totals, r.baseline?.minutes)}
<h2>How far this can be trusted</h2>
<ul class="compact">
<li><b>Record:</b> TomTom live-traffic routing every 15 minutes; ${esc(r.source?.text || '')}.</li>
<li><b>Second source:</b> ${esc(agreementText(r.agreement))}.</li>
<li><b>Ground truth:</b> ${esc(groundTruthText(r.truth))}.</li>
<li><b>Rain:</b> ${esc(rainText(rain))}.</li>
${impacts.length ? impacts.map((i) => `<li><b>Change evaluated:</b> ${esc(i.title)}: ${esc(impactText(i.result, names))}</li>`).join('') : '<li><b>Changes evaluated:</b> none on this road yet.</li>'}
</ul>
<footer>Chennai road monitor · method and limits: /methodology · traffic data © TomTom, checked against Google Maps Platform · rain: Open-Meteo${formal ? '' : ' · <b>Observations, not findings: not for formal submissions until marked fit for formal use.</b>'}</footer>
</section>`;
}

/** A full document of one or more road briefs. */
export function renderBriefs({ sections, title = 'Chennai roads · brief', index = null }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
@page{size:A4;margin:12mm}
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#eef0f3;color:#111;font:13px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.bar{max-width:210mm;margin:12px auto;display:flex;gap:8px;align-items:center;justify-content:space-between}.bar a,.bar button{font:inherit;color:#1a5fb4}
.bar button{border:1px solid #1a5fb4;background:#fff;border-radius:6px;padding:6px 12px;cursor:pointer}
.page{background:#fff;max-width:210mm;margin:0 auto 14px;padding:12mm;box-shadow:0 1px 4px rgba(0,0,0,.12)}
header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:6px}
h1{font-size:19px;margin:0}h2{font-size:14px;margin:14px 0 6px;border-bottom:1px solid #ddd;padding-bottom:2px}
.muted{color:#666}.small{font-size:11px}
.status{text-align:right;font-weight:700;font-size:13px;border-radius:6px;padding:6px 10px;max-width:60%}.status span{display:block;font-weight:400;font-size:11px}
.status.ok{background:#e8f5ec;color:#1e8449}.status.warn{background:#fff6e0;color:#7f6000}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0}.tiles div{border:1px solid #ddd;border-radius:6px;padding:6px 8px}
.tiles span{display:block;font-size:11px;color:#666}.tiles b{display:block;font-size:20px}.tiles em{font-style:normal;font-size:11px;color:#666}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid #e3e3e3;padding:4px 6px;text-align:right}th:first-child,td:first-child{text-align:left}
ul{margin:4px 0;padding-left:18px}li{margin:2px 0}ul.compact li{margin:3px 0}
footer{margin-top:12px;border-top:1px solid #ddd;padding-top:6px;font-size:10.5px;color:#555}
.index{max-width:210mm;margin:0 auto 14px;background:#fff;padding:10mm}.index a{color:#1a5fb4}
@media print{body{background:#fff}.bar,.index{display:none}.page{box-shadow:none;margin:0;max-width:none;padding:0;page-break-after:always}}
@media (max-width:640px){.tiles{grid-template-columns:repeat(2,1fr)}header{flex-direction:column}.status{max-width:none;text-align:left}}
</style></head><body>
<div class="bar"><a href="/">← Chennai roads today</a><button onclick="window.print()">Print or save as PDF</button></div>
${index || ''}
${sections.join('\n')}
</body></html>`;
}
