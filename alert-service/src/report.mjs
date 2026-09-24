/** Self-contained HTML report for one corridor: no external assets. */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const mins = (s) => (s == null ? '—' : `${(s / 60).toFixed(1)} min`);
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

export function renderReport({ corridor, series, latest, notes, comparison, windows, tz = 'IST' }) {
  const last = series[series.length - 1];
  const cmp = comparison
    ? `<h2>Before vs during</h2>
       <p class="muted">Before: ${esc(windows.a)} · During: ${esc(windows.b)} · same time-of-day slots, ${tz}. Speed ratio is live speed ÷ free-flow speed over the corridor's sample points; 100% is an empty road.</p>
       ${comparison.worst ? `<p class="headline">Worst slot ${comparison.worst.label}: ${pct(comparison.worst.before)} → ${pct(comparison.worst.during)} (${comparison.worst.change >= 0 ? '+' : ''}${Math.round(comparison.worst.change * 100)} points). Mean change across matching slots: ${comparison.meanChange == null ? '—' : `${comparison.meanChange >= 0 ? '+' : ''}${Math.round(comparison.meanChange * 100)} points`}.</p>` : '<p class="muted">No overlapping time slots yet.</p>'}
       <table><thead><tr><th>Slot</th><th>Before</th><th>During</th><th>Change</th><th>Travel before</th><th>Travel during</th><th>Samples</th></tr></thead><tbody>
       ${comparison.rows.map((r) => `<tr class="${r.change < -0.15 ? 'bad' : r.change > 0.1 ? 'good' : ''}"><td>${r.label}</td><td>${pct(r.before)}</td><td>${pct(r.during)}</td><td>${r.change >= 0 ? '+' : ''}${Math.round(r.change * 100)}</td><td>${mins(r.beforeTravelS)}</td><td>${mins(r.duringTravelS)}</td><td>${r.samplesBefore}/${r.samplesDuring}</td></tr>`).join('')}
       </tbody></table>`
    : `<p class="muted">Add <code>?a=YYYY-MM-DD..YYYY-MM-DD&amp;b=YYYY-MM-DD..YYYY-MM-DD</code> to compare two periods slot by slot.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(corridor.name)}</title>
<style>
:root{color-scheme:dark}body{margin:0;padding:16px;background:#0e1218;color:#e6edf3;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:980px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}.muted{color:#9aa4b2}.headline{font-size:15px;color:#ffd93d}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:5px 8px;border-bottom:1px solid #222b36;text-align:right}th:first-child,td:first-child{text-align:left}
tr.bad td{color:#ff7a8a}tr.good td{color:#7fe6a5}code{background:#1a2230;padding:1px 4px;border-radius:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.tile{background:#151b24;border-radius:8px;padding:10px}.tile b{display:block;font-size:20px}
.pts{display:flex;gap:3px;margin:8px 0}.pts span{flex:1;height:14px;border-radius:3px}
</style></head><body>
<h1>${esc(corridor.name)}</h1>
<p class="muted">${corridor.lengthKm} km · ${corridor.points.length} sample points · TomTom flow, every few minutes · times in ${tz}</p>
<div class="grid">
<div class="tile"><span class="muted">Now (${last ? ist(last.ts) : '—'})</span><b>${pct(last?.speed_ratio)}</b><span class="muted">of free-flow speed</span></div>
<div class="tile"><span class="muted">Mean speed</span><b>${last?.mean_speed == null ? '—' : Math.round(last.mean_speed) + ' km/h'}</b><span class="muted">free flow ${last?.mean_free_flow == null ? '—' : Math.round(last.mean_free_flow) + ' km/h'}</span></div>
<div class="tile"><span class="muted">Sampled travel time</span><b>${mins(last?.travel_time_s)}</b><span class="muted">free flow ${mins(last?.free_flow_travel_time_s)}</span></div>
<div class="tile"><span class="muted">Samples stored</span><b>${series.length}</b><span class="muted">${series.length ? ist(series[0].ts) : '—'} → ${last ? ist(last.ts) : '—'}</span></div>
</div>
<h2>Along the corridor, latest</h2>
<div class="pts" title="one block per sample point, start → end">${latest.points.map((p) => { const r = p.current_speed != null && p.free_flow_speed ? p.current_speed / p.free_flow_speed : null; const c = r == null ? '#333' : r > 0.75 ? '#2ecc71' : r > 0.5 ? '#f1c40f' : r > 0.3 ? '#e67e22' : '#e74c3c'; return `<span style="background:${c}" title="${p.point_index}: ${p.current_speed ?? '—'} / ${p.free_flow_speed ?? '—'} km/h"></span>`; }).join('')}</div>
<h2>Speed ratio, last ${windows.hours} hours</h2>
${lineChart(series, { notes })}
${cmp}
<h2>Notes</h2>
<p class="muted">Mark what changed and when (a closed U-turn, a diversion) so the chart explains itself: <code>POST /corridors/${esc(corridor.id)}/notes {"at":"2026-09-24T09:00:00Z","text":"U-turns closed"}</code></p>
<ul>${notes.map((n) => `<li>${ist(n.at)} — ${esc(n.text)}</li>`).join('') || '<li class="muted">none yet</li>'}</ul>
<p class="muted">Traffic flow data © TomTom. Ratios are averages over sample points and are not an official travel-time measurement.</p>
</body></html>`;
}
