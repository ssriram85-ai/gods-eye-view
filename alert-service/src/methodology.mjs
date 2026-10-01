/**
 * The public methodology page: what is measured, how every figure is
 * defined, how far each road's findings can be trusted today, and the
 * known limits. Numbers on the page are live, from the recorded data.
 */
import { SHIFT_MIN_SAVING, CONFIDENCE, VARIES_MIN, SOURCE_LEVELS } from './insights.mjs';
import { agreementText } from './crosscheck.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export function renderMethodology({ roads, incidentCounts = [], incidentsSince = null, rainSince = null, retentionDays = 0, exportPublic = false, notes = [], crosscheck = null, generatedAt = new Date() }) {
  const agree = new Map((crosscheck?.rows || []).map((r) => [r.corridor_id, r]));
  const levelColour = { established: '#1e8449', provisional: '#b7950b', early: '#7f8c8d' };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>How these numbers are made</title>
<style>
:root{--bg:#fff;--text:#111;--muted:#666;--line:#e3e5e8;--accent:#1a5fb4;--card:#f6f7f9}
@media (prefers-color-scheme:dark){:root{--bg:#0e1218;--text:#e6edf3;--muted:#9aa4b2;--line:#243040;--accent:#6cb6ff;--card:#151b24}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:900px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p,li{max-width:75ch}.muted{color:var(--muted)}a{color:var(--accent)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:13px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px}dt{font-weight:600}dd{margin:0}.pill{display:inline-block;color:#fff;border-radius:99px;padding:1px 8px;font-size:12px;font-weight:600}
.box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
@media (max-width:600px){dl{grid-template-columns:1fr}dt{margin-top:6px}table{font-size:13px}}
</style></head><body><main>
<h1>How these numbers are made</h1>
<p class="muted">Chennai road monitor · generated ${esc(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC · <a href="/">today's page</a> · <a href="/weekly">weekly report</a></p>

<h2>What is measured</h2>
<p>Every 15 minutes, for each road and direction below, the service asks TomTom's routing service for the live-traffic drive along the road, split at the named junctions. Each reading gives the live minutes for every stretch, TomTom's typical minutes for that moment from its own history, and TomTom's no-traffic minutes. Stops are snapped onto the road in the direction of travel, so readings follow the same carriageway every time. A reading is kept only if every stretch returned.</p>

<h2>How far each road can be trusted today</h2>
<table><tr><th>Road</th><th>Since</th><th>Weekdays</th><th>Weekend days</th><th>Source</th><th>Status</th></tr>
${roads.map((r) => `<tr><td>${esc(r.corridor.name)}<div class="muted">${r.corridor.lengthKm} km · ${(r.corridor.definition?.sections || []).length} stretches</div></td><td>${esc(String(r.since || '—').slice(0, 10))}</td><td>${r.days.weekdays}</td><td>${r.days.weekendDays}</td><td>${{ observed: 'Varies day to day (live)', partly: 'Partly live', modelled: "Mostly TomTom's pattern", unknown: 'Not yet known' }[r.source.kind]}<div class="muted">${r.source.share == null ? 'needs two weekdays' : `${pct(r.source.share)} of half-hour slots differ between weekdays by ${VARIES_MIN}+ min`}</div></td><td><span class="pill" style="background:${levelColour[r.confidence.level]}">${esc(r.confidence.level)}</span></td></tr>`).join('')}
</table>
<p class="muted">Status: <b>early</b> under ${CONFIDENCE.provisional} weekdays; <b>provisional</b> from ${CONFIDENCE.provisional}; <b>established</b> from ${CONFIDENCE.established}. Findings marked early or provisional are shown as such and are not for formal submissions.</p>

<h2>Second source: Google</h2>
${crosscheck?.configured ? `<p>Every hour from 06:00 to 23:00 and once at 03:00 (IST), the same drives are requested from Google's Routes service with live traffic, at the moment of a TomTom reading, and compared. Google's terms do not allow its travel times to be stored, so only the outcome of each comparison is kept: whether the two agree within 10% or 20%, whether both saw congestion (live at least 20% over each source's own no-traffic time), and how many stretches agree. Last 30 days:</p>
<table><tr><th>Road</th><th>Agreement with Google</th></tr>${roads.map((r) => `<tr><td>${esc(r.corridor.name)}</td><td>${esc(agreementText(agree.get(r.corridor.id)))}${agree.get(r.corridor.id)?.route_differs ? `<div class="muted">${agree.get(r.corridor.id).route_differs} check(s) skipped: Google chose a different route</div>` : ''}</td></tr>`).join('')}</table>` : '<p>A second traffic source (Google Routes) is being connected. Until it is, every travel time on this site rests on TomTom alone.</p>'}

<h2>Definitions</h2>
<dl>
<dt>Typical</dt><dd>The median of all readings in the same 30-minute departure slot, weekdays and weekends kept apart.</dd>
<dt>Most days</dt><dd>The 10th to 90th percentile of the same slot: the range nine days in ten fall into.</dd>
<dt>Night-time drive</dt><dd>The quickest typical slot between midnight and 05:30. This is the reference for "extra" time. TomTom's no-traffic time is recorded but not used as the reference, because on these roads it is slower than real night drives.</dd>
<dt>Rush</dt><dd>The busiest slot in the morning (05:00–13:00) and in the afternoon and evening (13:00–24:00), and the span either side where the road stays at least 30% of the way from its night-time drive to that peak, found over the whole day, never inside a fixed window. The two spans meet at the quietest slot between the peaks; when even that midday low stays busy, the day is reported as one continuous busy period with two peaks.</dd>
<dt>Departure advice</dt><dd>Given only when leaving up to an hour earlier or later than the peak saves at least ${SHIFT_MIN_SAVING} minutes. Otherwise the page says there is no quick win.</dd>
<dt>Bottleneck</dt><dd>A stretch is named only if it carries at least a third of the extra time at the peak and at least one and a half times as much as the next stretch. Otherwise the delay is described as spread along the road.</dd>
<dt>Unusual now</dt><dd>The live drive is at least 5 minutes and 12% over typical for this slot, or more than 3 minutes above its "most days" range.</dd>
<dt>Live or pattern</dt><dd>TomTom's "live" time falls back on its historical pattern where it has little live data, and a pattern repeats itself every day. So each road is tested on day-to-day variation: the share of weekday half-hour slots, recorded on at least two weekdays, whose drive differed between days by ${VARIES_MIN} minutes or more. ${Math.round(SOURCE_LEVELS.live * 100)}% or more: varies day to day (live). ${Math.round(SOURCE_LEVELS.partly * 100)}–${Math.round(SOURCE_LEVELS.live * 100)}%: partly live. Below ${Math.round(SOURCE_LEVELS.partly * 100)}%: mostly TomTom's pattern, so its day-to-day changes are not well observed.</dd>
<dt>Recurring jam</dt><dd>A place (about 330 m across) where TomTom reports a major jam (magnitude 3 or 4, or at least 5 minutes of delay) on two or more days.</dd>
</dl>

<h2>Known limits</h2>
<ul>
<li><b>${crosscheck?.configured ? 'Second source is a check, not a record.' : 'One traffic source.'}</b> ${crosscheck?.configured ? 'All published travel times come from TomTom; Google is used only to measure how often the two agree. Timed drives on the ground are planned and not yet in place.' : 'All travel times come from TomTom. A second source and timed drives on the ground are planned and not yet in place.'}</li>
<li><b>Model on some roads.</b> Where TomTom has little live data, its "live" time follows its historical pattern. Those roads are labelled above; their day-to-day changes are not well observed.</li>
<li><b>No accident record.</b> TomTom's incident feed for Chennai${incidentsSince ? ` since ${esc(incidentsSince.slice(0, 10))}` : ''} reports ${incidentCounts.length ? incidentCounts.map((c) => `${c.n} ${esc(c.category)}`).join(', ') : 'no incidents yet'}. Accident locations need official records (iRAD or the Traffic Police's blackspot list); nothing here is an accident statistic.</li>
<li><b>Rain is modelled.</b> Hourly rainfall per road comes from Open-Meteo's weather model${rainSince ? ` (recorded since ${esc(rainSince.slice(0, 10))})` : ''}, not from rain gauges.</li>
<li><b>15-minute sampling.</b> A jam shorter than a quarter hour can be missed; readings describe departures, not every minute of the road.</li>
<li><b>Holidays and events</b> are marked from the Tamil Nadu government holiday list and from notes; days around them are kept in the record and flagged in reports.</li>
</ul>

<h2>Licensing and retention</h2>
<div class="box">
<p>Traffic data © TomTom, used under TomTom's developer terms, which allow commercial use and prohibit use for traffic-law enforcement such as choosing speed-camera sites. TomTom's terms also limit how long downloaded traffic content may be kept. ${retentionDays > 0 ? `Raw readings are deleted after ${retentionDays} days; daily summaries by departure slot are kept.` : 'Raw readings are currently kept while that limit is confirmed with TomTom; daily summaries by departure slot are kept regardless.'}</p>
<p>The summary export (one line per road, day and departure slot) is ${exportPublic ? 'public at <a href="/export/slots.csv">/export/slots.csv</a>' : 'available on request while the licensing question is open'}.</p>
</div>

${notes.length ? `<h2>Events and changes on record</h2><table><tr><th>When (IST)</th><th>What</th></tr>${notes.map((n) => `<tr><td>${esc(new Date(Date.parse(n.at) + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' '))}</td><td>${esc(n.text)}</td></tr>`).join('')}</table>` : ''}

<h2>Method history</h2>
<p>From 24 to 29 September 2026 the monitor sampled TomTom point speeds. On OMR those points shared a few long road segments, which hid local jams, so that method was retired. Section travel times began on 29 September 2026 at 11:30 IST; all findings above rest on them.</p>
</main></body></html>`;
}
