/** Self-contained HTML report for one corridor: no external assets. */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const mins = (s) => (s == null ? '—' : `${(s / 60).toFixed(1)} min`);
// Corridor travel time is estimated as length ÷ mean sampled speed. (Summing
// TomTom's per-segment travel times overstates it: segments are longer than
// the spacing between sample points.)
const travelS = (lengthKm, speedKmh) => (lengthKm && speedKmh ? (lengthKm / speedKmh) * 3600 : null);
const ist = (iso) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(5, 16).replace('T', ' ');

function lineChart(series, { width = 900, height = 220, key = 'speed_ratio', notes = [] } = {}) {
  const pts = series.filter((r) => r[key] != null);
  if (pts.length < 2) return `<p class="muted">Not enough samples yet for a chart.</p>`;
  const t0 = Date.parse(pts[0].ts), t1 = Date.parse(pts[pts.length - 1].ts) || t0 + 1;
  const x = (ts) => 40 + ((Date.parse(ts) - t0) / (t1 - t0 || 1)) * (width - 60);
  const y = (v) => 10 + (1 - Math.min(1.2, Math.max(0, v)) / 1.2) * (height - 40);
  const path = pts.map((r, i) => `${i ? 'L' : 'M'}${x(r.ts).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  const grid = [0.25, 0.5, 0.75, 1].map((g) => `<line x1="40" x2="${width - 20}" y1="${y(g)}" y2="${y(g)}" stroke="#2a3340"/><text x="4" y="${y(g) + 4}" fill="#8fa" font-size="11">${Math.round(g * 100)}%</text>`).join('');
  const marks = notes.filter((n) => Date.parse(n.at) >= t0 && Date.parse(n.at) <= t1)
    .map((n) => `<line x1="${x(n.at)}" x2="${x(n.at)}" y1="10" y2="${height - 30}" stroke="#ffb020" stroke-dasharray="4 3"/><text x="${x(n.at) + 3}" y="20" fill="#ffb020" font-size="11">${esc(n.text)}</text>`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => { const ts = new Date(t0 + f * (t1 - t0)).toISOString(); return `<text x="${x(ts)}" y="${height - 12}" fill="#9aa" font-size="11" text-anchor="middle">${ist(ts)}</text>`; }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="speed ratio over time">${grid}<path d="${path}" fill="none" stroke="#52d4ff" stroke-width="2"/>${marks}${ticks}</svg>`;
}

/** Whole-corridor minutes over time, with the empty-road time as a dashed line. */
function minutesChart(totals, { width = 900, height = 230, notes = [] } = {}) {
  const pts = totals.filter((r) => r.travel_s != null);
  if (pts.length < 2) return `<p class="muted">Not enough section readings yet for a chart.</p>`;
  const t0 = Date.parse(pts[0].ts), t1 = Date.parse(pts[pts.length - 1].ts) || t0 + 1;
  const max = Math.max(...pts.map((r) => r.travel_s / 60)) * 1.1 || 1;
  const x = (ts) => 44 + ((Date.parse(ts) - t0) / (t1 - t0 || 1)) * (width - 64);
  const y = (v) => 10 + (1 - v / max) * (height - 40);
  const line = (key) => pts.map((r, i) => `${i ? 'L' : 'M'}${x(r.ts).toFixed(1)},${y(r[key] / 60).toFixed(1)}`).join(' ');
  const step = max > 60 ? 20 : 10;
  const grid = Array.from({ length: Math.floor(max / step) }, (_, i) => (i + 1) * step).map((g) => `<line x1="44" x2="${width - 20}" y1="${y(g)}" y2="${y(g)}" stroke="#2a3340"/><text x="4" y="${y(g) + 4}" fill="#9aa" font-size="11">${g} min</text>`).join('');
  const marks = notes.filter((n) => Date.parse(n.at) >= t0 && Date.parse(n.at) <= t1)
    .map((n) => `<line x1="${x(n.at)}" x2="${x(n.at)}" y1="10" y2="${height - 30}" stroke="#ffb020" stroke-dasharray="4 3"/><text x="${x(n.at) + 3}" y="20" fill="#ffb020" font-size="11">${esc(n.text)}</text>`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => { const ts = new Date(t0 + f * (t1 - t0)).toISOString(); return `<text x="${x(ts)}" y="${height - 12}" fill="#9aa" font-size="11" text-anchor="middle">${ist(ts)}</text>`; }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="travel minutes over time">${grid}<path d="${line('no_traffic_s')}" fill="none" stroke="#7f8c8d" stroke-dasharray="5 4" stroke-width="1.5"/><path d="${line('travel_s')}" fill="none" stroke="#52d4ff" stroke-width="2"/>${marks}${ticks}</svg>
<p class="muted">Blue: live travel time for the whole road. Grey dashes: TomTom's empty-road time for the same route.</p>`;
}

const LEVEL_COLOR = { clear: '#2ecc71', busy: '#f1c40f', heavy: '#e67e22', jammed: '#e74c3c', unknown: '#7f8c8d' };

/** The section-travel-time part of a corridor report. */
function travelSection(corridor, t, notes, hours) {
  const sections = corridor.definition?.sections || [];
  const st = t.status;
  const rows = t.latest?.rows || [];
  const wk = (t.profile?.weekday || []).filter((p) => p.days >= 1);
  const maxWk = Math.max(1, ...wk.map((p) => p.minutes));
  return `<div class="grid">
<div class="tile"><span class="muted">Now (${st ? ist(st.ts) : '—'})</span><b style="color:${LEVEL_COLOR[st?.level || 'unknown']}">${st ? Math.round(st.minutes) + ' min' : '—'}</b><span class="muted">${st?.level || ''}</span></div>
<div class="tile"><span class="muted">Usual at this time</span><b>${st?.usualMinutes == null ? '—' : Math.round(st.usualMinutes) + ' min'}</b><span class="muted">${st?.usualSource === 'recorded' ? 'from our recordings' : "TomTom's history"}</span></div>
<div class="tile"><span class="muted">Empty road</span><b>${st ? Math.round(st.freeMinutes) + ' min' : '—'}</b><span class="muted">still includes signals</span></div>
<div class="tile"><span class="muted">Jams on the route now</span><b>${st?.jams ?? '—'}</b><span class="muted">${st?.detour ? 'live route left the road' : 'TomTom traffic sections'}</span></div>
</div>
${t.tips?.length ? `<h2>Advice</h2><ul>${t.tips.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>` : `<p class="muted">Departure advice appears once two weekdays have been recorded.</p>`}
<h2>Stretch by stretch, latest</h2>
<table><thead><tr><th>Stretch</th><th>Length</th><th>Now</th><th>Empty road</th><th>Extra</th></tr></thead><tbody>
${sections.map((s, i) => { const r = rows.find((x) => x.leg === i); const extra = r ? (r.travel_s - r.no_traffic_s) / 60 : null; return `<tr class="${extra != null && extra >= 5 ? 'bad' : ''}"><td>${esc(s.from)} → ${esc(s.to)}</td><td>${s.lengthKm} km</td><td>${r ? mins(r.travel_s) : '—'}</td><td>${r ? mins(r.no_traffic_s) : '—'}</td><td>${extra == null ? '—' : `+${extra.toFixed(1)} min`}</td></tr>`; }).join('')}
</tbody></table>
<h2>Whole road, last ${hours} hours</h2>
${minutesChart(t.totals, { notes })}
${wk.length ? `<h2>Typical weekday, by departure time</h2>
<div class="bars">${wk.map((p) => `<div title="${p.label}: ${Math.round(p.minutes)} min (${p.days} day${p.days > 1 ? 's' : ''})"><span style="height:${Math.round((p.minutes / maxWk) * 100)}%"></span><em>${p.slot % 120 === 0 ? p.label.slice(0, 2) : ''}</em></div>`).join('')}</div>
<p class="muted">Each bar is a 30-minute departure slot, averaged over the weekdays recorded so far.</p>` : ''}`;
}

export function renderReport({ corridor, series, latest, notes, comparison, windows, tz = 'IST', travel = null }) {
  const last = series[series.length - 1];
  const cmp = comparison
    ? `<h2>Before vs during</h2>
       <p class="muted">Before: ${esc(windows.a)} · During: ${esc(windows.b)} · same time-of-day slots, ${tz}. Speed ratio is live speed ÷ free-flow speed over the corridor's sample points; 100% is an empty road.</p>
       ${comparison.worst ? `<p class="headline">Worst slot ${comparison.worst.label}: ${pct(comparison.worst.before)} → ${pct(comparison.worst.during)} (${comparison.worst.change >= 0 ? '+' : ''}${Math.round(comparison.worst.change * 100)} points). Mean change across matching slots: ${comparison.meanChange == null ? '—' : `${comparison.meanChange >= 0 ? '+' : ''}${Math.round(comparison.meanChange * 100)} points`}.</p>` : '<p class="muted">No overlapping time slots yet.</p>'}
       <table><thead><tr><th>Slot</th><th>Before</th><th>During</th><th>Change</th><th>Travel before</th><th>Travel during</th><th>Samples</th></tr></thead><tbody>
       ${comparison.rows.map((r) => `<tr class="${r.change < -0.15 ? 'bad' : r.change > 0.1 ? 'good' : ''}"><td>${r.label}</td><td>${pct(r.before)}</td><td>${pct(r.during)}</td><td>${r.change >= 0 ? '+' : ''}${Math.round(r.change * 100)}</td><td>${mins(travelS(corridor.lengthKm, r.beforeSpeed))}</td><td>${mins(travelS(corridor.lengthKm, r.duringSpeed))}</td><td>${r.samplesBefore}/${r.samplesDuring}</td></tr>`).join('')}
       </tbody></table>`
    : `<p class="muted">Add <code>?a=YYYY-MM-DD..YYYY-MM-DD&amp;b=YYYY-MM-DD..YYYY-MM-DD</code> to compare two periods slot by slot.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(corridor.name)}</title>
<style>
:root{color-scheme:dark}body{margin:0;padding:16px;background:#0e1218;color:#e6edf3;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:980px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}.muted{color:#9aa4b2}.headline{font-size:15px;color:#ffd93d}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:5px 8px;border-bottom:1px solid #222b36;text-align:right}th:first-child,td:first-child{text-align:left}
tr.bad td{color:#ff7a8a}tr.good td{color:#7fe6a5}code{background:#1a2230;padding:1px 4px;border-radius:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.tile{background:#151b24;border-radius:8px;padding:10px}.tile b{display:block;font-size:20px}
.pts{display:flex;gap:3px;margin:8px 0}a{color:#52d4ff}ul{padding-left:20px}li{margin:4px 0}.bars{display:flex;align-items:flex-end;gap:2px;height:140px;margin:8px 0 18px}.bars div{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;position:relative}.bars span{display:block;background:#52d4ff;border-radius:2px 2px 0 0}.bars em{position:absolute;bottom:-16px;left:0;font-size:10px;color:#9aa;font-style:normal}.pts span{flex:1;height:14px;border-radius:3px}
</style></head><body>
<h1>${esc(corridor.name)}</h1>
<p class="muted">${corridor.lengthKm} km · ${travel ? `${(corridor.definition?.sections || []).length} stretches · TomTom live-traffic routing every 15 minutes` : `${corridor.points.length} sample points · TomTom flow`} · times in ${tz} · <a href="/">all roads</a></p>
${travel ? travelSection(corridor, travel, notes, windows.hours) + (series.length ? '<h2 class="muted">Earlier record: point speeds, 24–29 Sep 2026</h2><p class="muted">Before section travel times, the monitor sampled TomTom flow at points; on OMR those points shared a few long road segments, so it understated local jams. Kept for reference.</p>' : '') : ''}
${!travel || series.length ? `<div class="grid">
<div class="tile"><span class="muted">Now (${last ? ist(last.ts) : '—'})</span><b>${pct(last?.speed_ratio)}</b><span class="muted">of free-flow speed</span></div>
<div class="tile"><span class="muted">Mean speed</span><b>${last?.mean_speed == null ? '—' : Math.round(last.mean_speed) + ' km/h'}</b><span class="muted">free flow ${last?.mean_free_flow == null ? '—' : Math.round(last.mean_free_flow) + ' km/h'}</span></div>
<div class="tile"><span class="muted">Est. travel time</span><b>${mins(travelS(corridor.lengthKm, last?.mean_speed))}</b><span class="muted">free flow ${mins(travelS(corridor.lengthKm, last?.mean_free_flow))}</span></div>
<div class="tile"><span class="muted">Samples stored</span><b>${series.length}</b><span class="muted">${series.length ? ist(series[0].ts) : '—'} → ${last ? ist(last.ts) : '—'}</span></div>
</div>
<h2>Along the corridor, latest</h2>
<div class="pts" title="one block per sample point, start → end">${latest.points.map((p) => { const r = p.current_speed != null && p.free_flow_speed ? p.current_speed / p.free_flow_speed : null; const c = r == null ? '#333' : r > 0.75 ? '#2ecc71' : r > 0.5 ? '#f1c40f' : r > 0.3 ? '#e67e22' : '#e74c3c'; return `<span style="background:${c}" title="${p.point_index}: ${p.current_speed ?? '—'} / ${p.free_flow_speed ?? '—'} km/h"></span>`; }).join('')}</div>
<h2>Speed ratio, last ${windows.hours} hours</h2>
${lineChart(series, { notes })}
${cmp}
` : ''}
<h2>Notes</h2>
<p class="muted">Mark what changed and when (a closed U-turn, a diversion) so the chart explains itself: <code>POST /corridors/${esc(corridor.id)}/notes {"at":"2026-09-24T09:00:00Z","text":"U-turns closed"}</code></p>
<ul>${notes.map((n) => `<li>${ist(n.at)} — ${esc(n.text)}</li>`).join('') || '<li class="muted">none yet</li>'}</ul>
<p class="muted">Traffic flow data © TomTom. Ratios are averages over sample points; travel time is corridor length ÷ mean sampled speed, not an official travel-time measurement.</p>
</body></html>`;
}
