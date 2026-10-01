/**
 * The public "Chennai today" page: live road status with commuter tips,
 * hazard alerts for Tamil Nadu, current incidents and recurring trouble
 * spots. Built only from what the service has already recorded, so any
 * number of visitors costs no API quota. No login, nothing private.
 */
import { haversineKm, pointInRing } from './geo.mjs';
import { nextCommute } from './insights.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const m = (v) => (v == null ? '—' : `${Math.round(v)}`);
const ist = (iso) => (iso ? new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 16) : '—');
const istDate = (iso) => (iso ? new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ') : '—');

/** A coarse outline of Tamil Nadu (with Puducherry), [lon, lat], good to a few km. */
export const TAMIL_NADU = Object.freeze([
  [80.35, 13.6], [79.9, 13.5], [79.4, 13.35], [78.95, 13.05], [78.4, 12.75], [77.8, 12.85], [77.45, 12.4], [76.9, 11.95],
  [76.4, 11.7], [76.25, 11.4], [76.7, 11.2], [76.75, 10.8], [77.05, 10.5], [77.2, 10.1], [77.25, 9.5], [77.2, 8.95],
  [77.1, 8.3], [77.55, 8.0], [78.2, 8.4], [78.4, 9.1], [79.4, 9.2], [79.0, 10.3], [79.9, 10.3], [79.85, 11.3],
  [79.8, 12.0], [80.25, 12.7], [80.35, 13.6],
]);
const CHENNAI = { lat: 13.0827, lon: 80.2707 };
export const inTamilNadu = (lon, lat) => pointInRing(lon, lat, TAMIL_NADU);

/** Does a normalized event touch Tamil Nadu (cyclones: pass within 600 km of Chennai)? */
export function touchesTamilNadu(e) {
  const g = e?.geometry;
  if (!g) return false;
  if (g.type === 'point') return inTamilNadu(g.lon, g.lat);
  if (g.type === 'line') return (g.points || []).some(([lon, lat]) => haversineKm(lat, lon, CHENNAI.lat, CHENNAI.lon) <= 600);
  if (g.type === 'polygon') {
    if (e.source === 'jtwc') return (g.rings || []).some((ring) => ring.some(([lon, lat]) => haversineKm(lat, lon, CHENNAI.lat, CHENNAI.lon) <= 600));
    return (g.rings || []).some((ring) => ring.some(([lon, lat]) => inTamilNadu(lon, lat)) || pointInRing(CHENNAI.lon, CHENNAI.lat, ring));
  }
  return false;
}

const LEVEL = {
  clear: ['#1e8449', 'Clear'],
  busy: ['#b7950b', 'Busy'],
  heavy: ['#d35400', 'Heavy'],
  jammed: ['#c0392b', 'Jammed'],
  unknown: ['#7f8c8d', '—'],
};
const ROAD_NAMES = { omr: 'OMR · Rajiv Gandhi Salai', 'anna-salai': 'Anna Salai · Mount Road', gst: 'GST Road', ecr: 'ECR · East Coast Road' };

/**
 * roads: [{ corridor, status (liveStatus), tips, source, confidence, notes }]
 * events: normalized events (with geometry) from the last poll
 * incidentsNow, recurring, safety, weekCounts: from the incident store
 */
export function renderSummary({ roads, events = [], incidentsNow = [], recurring = [], safety = [], weekCounts = [], incidentsSince = null, weeklyUrl = '/weekly', updatedAt = new Date().toISOString(), feedsOk = true }) {
  const tnEvents = events.filter(touchesTamilNadu);
  const alerts = tnEvents.filter((e) => e.source === 'sachet');
  const storms = tnEvents.filter((e) => e.source === 'jtwc');
  const heat = tnEvents.filter((e) => e.source === 'heat' && e.severity === 'critical').sort((a, b) => (b.value?.peakC || 0) - (a.value?.peakC || 0));
  const accidents = incidentsNow.filter((i) => i.category === 'accident');
  const flooding = incidentsNow.filter((i) => i.category === 'flooding');
  const bigJams = incidentsNow.filter((i) => i.category === 'jam' && (i.delay_s || 0) >= 300).slice(0, 8);
  const byCat = incidentsNow.reduce((a, i) => ((a[i.category] = (a[i.category] || 0) + 1), a), {});
  const period = nextCommute(updatedAt);

  const roadIds = [...new Set(roads.map((r) => r.corridor.definition?.road))];
  const card = (r) => {
    const s = r.status;
    const [color, word] = LEVEL[s?.level || 'unknown'];
    const vs = s?.vsUsual == null ? '' : Math.abs(s.vsUsual) < 2 ? 'about typical' : `${s.vsUsual > 0 ? '+' : '−'}${Math.round(Math.abs(s.vsUsual))} min vs typical`;
    const rangeText = s?.usualRange ? ` (${m(s.usualRange[0])}–${m(s.usualRange[1])} most days)` : '';
    const forPeriod = (r.tips || []).filter((t) => t.period === period);
    const rush = forPeriod.find((t) => t.kind === 'rush' || t.kind === 'calm');
    const shift = forPeriod.find((t) => t.kind === 'shift') || forPeriod.find((t) => t.kind === 'no-shift');
    const conf = r.confidence;
    return `<div class="card">
<div class="row"><span class="dir">${esc(r.corridor.name.split('·')[0].trim())}</span><span>${s?.unusual ? '<span class="pill" style="background:#8e44ad">Unusual</span> ' : ''}<span class="pill" style="background:${color}">${word}</span></span></div>
<div class="route">${esc((r.corridor.name.split('·')[1] || '').trim())} · ${r.corridor.lengthKm} km</div>
<div class="big">${m(s?.minutes)}<small> min now</small></div>
<div class="muted">${s ? `typical now ${m(s.usualMinutes)}${rangeText}${vs ? ` · <b>${vs}</b>` : ''}<br>night-time drive ${m(s.nightMinutes)} min` : 'no reading yet'}</div>
${s?.slowest && s.slowest.extraMinutes >= 3 ? `<div class="muted">Slowest now: ${esc(s.slowest.section)} (+${Math.round(s.slowest.extraMinutes)} min on its night-time pace)</div>` : ''}
${s?.detour ? '<div class="warn">The live route left the road: likely a closure or diversion.</div>' : s?.closures ? '<div class="warn">TomTom reports a closure on the route.</div>' : ''}
${rush ? `<div class="tip"><b>${period === 'morning' ? 'Next: morning' : 'Next: evening'}.</b> ${esc(rush.text)}${shift ? ` ${esc(shift.text)}` : ''}${(r.notes || []).length ? ` ${esc(r.notes.join(' '))}` : ''}</div>` : `<div class="muted small">Rush-hour findings appear once each half-hour has been recorded on two weekdays.</div>`}
<div class="meta">${{ observed: 'Varies day to day (live)', partly: 'Partly live', modelled: "Mostly TomTom's pattern", unknown: 'Source not yet known' }[r.source?.kind || 'unknown']} · ${conf ? esc(conf.level) : ''} (${conf ? esc(String(r.days?.weekdays ?? '')) : ''} weekdays) · <a href="/corridors/${esc(r.corridor.id)}/report?hours=48">details</a></div>
</div>`;
  };

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chennai roads today</title><meta http-equiv="refresh" content="300">
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#111;--muted:#666;--line:#e3e5e8;--accent:#1a5fb4}
@media (prefers-color-scheme:dark){:root{--bg:#0e1218;--card:#151b24;--text:#e6edf3;--muted:#9aa4b2;--line:#243040;--accent:#6cb6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:22px;margin:0}h2{font-size:17px;margin:26px 0 10px}h3{font-size:15px;margin:14px 0 8px;color:var(--muted);font-weight:600}
.muted{color:var(--muted)}.small{font-size:13px}a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}.dir{font-weight:600}.route{color:var(--muted);font-size:13px;margin:2px 0 6px}
.pill{color:#fff;font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px}.big{font-size:28px;font-weight:700}.big small{font-size:13px;font-weight:400;color:var(--muted)}
.tip{margin:8px 0 6px;padding:8px;border-radius:6px;background:rgba(26,95,180,.08);font-size:13px}.meta{font-size:12px;color:var(--muted);margin-top:4px}.warn{color:#c0392b;font-size:13px;margin-top:4px}
table{border-collapse:collapse;width:100%;font-size:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:13px}
.sev-critical{color:#c0392b;font-weight:600}.sev-warning{color:#d35400;font-weight:600}.empty{padding:12px;background:var(--card);border:1px solid var(--line);border-radius:10px;color:var(--muted)}
footer{margin:30px 0 10px;font-size:12px;color:var(--muted)}
</style></head><body><main>
<h1>Chennai roads today</h1>
<p class="muted">Updated ${esc(ist(updatedAt))} IST · refreshes every 5 minutes · <a href="${esc(weeklyUrl)}">weekly report</a> · <a href="/methodology">how these numbers are made</a>${feedsOk ? '' : ' · <span class="warn">some hazard feeds are not answering</span>'}</p>

${roadIds.map((id) => `<h3>${esc(ROAD_NAMES[id] || id)}</h3><div class="grid">${roads.filter((r) => r.corridor.definition?.road === id).map(card).join('')}</div>`).join('')}

<h2>Alerts for Tamil Nadu</h2>
${alerts.length || storms.length || heat.length ? `<table><tr><th>Type</th><th>What</th><th>Issued by</th><th>Until</th></tr>
${storms.map((e) => `<tr><td class="sev-${esc(e.severity)}">Cyclone</td><td>${esc(e.headline)}</td><td>${esc(e.sender)}</td><td>—</td></tr>`).join('')}
${alerts.map((e) => `<tr><td class="sev-${esc(e.severity)}">${esc(e.event || e.category)}</td><td>${esc(e.headline)}</td><td>${esc(e.sender || 'NDMA SACHET')}</td><td>${esc(istDate(e.expires))}</td></tr>`).join('')}
${heat.length ? `<tr><td class="sev-critical">Heat stress</td><td>Feels like 41° or more today in ${heat.map((e) => `${esc(String(e.headline).split(':')[0])} ${Math.round(e.value?.peakC)}°`).join(', ')}. Avoid midday outdoor work; water and shade for traffic staff.</td><td>Open-Meteo</td><td>today</td></tr>` : ''}
</table>` : '<div class="empty">No active government alerts, cyclone warnings or heat stress for Tamil Nadu right now.</div>'}

<h2>Incidents in Chennai now</h2>
<p class="muted">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${esc(k)}`).join(' · ') || 'No incident data yet.'}</p>
${accidents.length || flooding.length || bigJams.length ? `<table><tr><th>What</th><th>Where</th><th>Delay</th><th>Map</th></tr>
${[...accidents, ...flooding, ...bigJams].map((i) => `<tr><td class="${i.category === 'accident' ? 'sev-critical' : i.category === 'flooding' ? 'sev-warning' : ''}">${esc(i.category)}${i.description ? `<div class="muted small">${esc(i.description)}</div>` : ''}</td><td>${esc([i.from_name, i.to_name].filter(Boolean).join(' → ') || i.road || '—')}</td><td>${i.delay_s ? `${Math.round(i.delay_s / 60)} min` : '—'}</td><td><a href="https://www.google.com/maps?q=${i.lat},${i.lon}">open</a></td></tr>`).join('')}
</table>` : '<div class="empty">No accidents, flooding or major jams reported right now.</div>'}

<h2>Recurring jams, last 30 days</h2>
<p class="muted small">Places where TomTom reported a major jam on two or more different days, ranked by days seen. Counts of live reports, not official records${incidentsSince ? `; recording since ${esc(incidentsSince.slice(0, 10))}` : ''}.</p>
${recurring.length ? `<table><tr><th>Place</th><th>Days seen</th><th>Typical delay</th><th>Map</th></tr>
${recurring.map((h) => `<tr><td>${esc(h.place || 'unnamed road')}</td><td>${h.days}</td><td>${h.typicalDelayMinutes != null ? `${h.typicalDelayMinutes} min` : '—'}</td><td><a href="https://www.google.com/maps?q=${h.lat},${h.lon}">open</a></td></tr>`).join('')}
</table>` : '<div class="empty">No jam has recurred on two different days yet.</div>'}
<h2>Accidents and flooding</h2>
${safety.length ? `<table><tr><th>Place</th><th>Reports</th><th>Days</th><th>What</th><th>Map</th></tr>
${safety.map((h) => `<tr><td>${esc(h.place || 'unnamed road')}</td><td>${h.reports}</td><td>${h.days}</td><td>${Object.entries(h.kinds).map(([k, n]) => `${n} ${esc(k)}`).join(', ')}</td><td><a href="https://www.google.com/maps?q=${h.lat},${h.lon}">open</a></td></tr>`).join('')}
</table>` : `<div class="empty">TomTom has reported no accidents, breakdowns or flooding in Chennai${incidentsSince ? ` since ${esc(incidentsSince.slice(0, 10))}` : ''}. Accident locations need official records; see <a href="/methodology">how these numbers are made</a>.</div>`}
${weekCounts.length ? `<p class="muted small">Reported this week: ${weekCounts.map((c) => `${c.n} ${esc(c.category)}`).join(', ')}.</p>` : ''}

<footer>Road times: TomTom live-traffic routing along each road every 15 minutes, split at the named junctions. "Typical" is the median for this half-hour on recorded weekdays (or weekends), with the range most days fall into; "night-time drive" is the quickest typical time after midnight. Findings marked early or provisional rest on few days. <a href="/methodology">How these numbers are made</a>. Alerts: NDMA SACHET (Government of India), JTWC, Open-Meteo. Incidents: TomTom. Traffic data © TomTom. Built with God's Eye View.</footer>
</main></body></html>`;
}
