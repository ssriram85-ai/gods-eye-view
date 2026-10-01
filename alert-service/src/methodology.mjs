/**
 * The public methodology page: the sources and what each is used for, how
 * a reading is made, how the second source checks it, how far each road's
 * findings can be trusted today and when they are fit for a formal
 * submission, how every figure is defined, and the known limits. Numbers
 * on the page are live, from the recorded data.
 */
import { SHIFT_MIN_SAVING, CONFIDENCE, VARIES_MIN, SOURCE_LEVELS } from './insights.mjs';
import { agreementText, describeHours, formalReadiness, FORMAL } from './crosscheck.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const VARIES_LABEL = { observed: 'Varies day to day (live)', partly: 'Partly live', modelled: "Mostly TomTom's pattern", unknown: 'Not yet known' };

export function renderMethodology({ roads, incidentCounts = [], incidentsSince = null, rainSince = null, retentionDays = 0, exportPublic = false, notes = [], crosscheck = null, generatedAt = new Date() }) {
  const agree = new Map((crosscheck?.rows || []).map((r) => [r.corridor_id, r]));
  const google = Boolean(crosscheck?.configured);
  const hoursText = crosscheck?.hours ? describeHours(crosscheck.hours) : '03:00 and every hour from 06:00 to 23:00';
  const levelColour = { established: '#1e8449', provisional: '#b7950b', early: '#7f8c8d' };
  const totalChecks = [...agree.values()].reduce((a, r) => a + (r.compared || 0), 0);
  const totalWithin10 = [...agree.values()].reduce((a, r) => a + (r.within10 || 0), 0);
  const totalWithin20 = [...agree.values()].reduce((a, r) => a + (r.within20 || 0), 0);
  const ready = roads.filter((r) => formalReadiness(r.confidence, agree.get(r.corridor.id)).ready).length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>How these numbers are made</title>
<style>
:root{--bg:#fff;--text:#111;--muted:#666;--line:#e3e5e8;--accent:#1a5fb4;--card:#f6f7f9}
@media (prefers-color-scheme:dark){:root{--bg:#0e1218;--text:#e6edf3;--muted:#9aa4b2;--line:#243040;--accent:#6cb6ff;--card:#151b24}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:30px 0 8px}p,li{max-width:78ch}.muted{color:var(--muted)}a{color:var(--accent)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600;font-size:13px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px}dt{font-weight:600}dd{margin:0}.pill{display:inline-block;color:#fff;border-radius:99px;padding:1px 8px;font-size:12px;font-weight:600;white-space:nowrap}
.box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px}.box ul{margin:6px 0;padding-left:20px}
.wrap{overflow-x:auto}
@media (max-width:640px){dl{grid-template-columns:1fr}dt{margin-top:6px}table{font-size:13px}}
</style></head><body><main>
<h1>How these numbers are made</h1>
<p class="muted">Chennai road monitor · generated ${esc(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC · <a href="/">today's page</a> · <a href="/weekly">weekly report</a></p>

<div class="box"><b>In short</b>
<ul>
<li><b>The record</b> is TomTom's live-traffic drive along each road, every 15 minutes, split at named junctions.</li>
<li><b>The check</b> is ${google ? `Google's live-traffic drive for the same road at the same moment, ${esc(hoursText)} (IST). ${totalChecks ? `So far TomTom's time has been within 10% of Google's in ${pct(totalWithin10 / totalChecks)} of ${totalChecks} checks, and within 20% in ${pct(totalWithin20 / totalChecks)}.` : 'Checks have just started.'}` : 'being connected; until it is, every figure rests on TomTom alone.'}</li>
<li><b>Fit for a formal submission</b> today: ${ready} of ${roads.length} road directions, by the rule further down. The rest are labelled early or provisional wherever they appear.</li>
<li><b>Not covered:</b> accident statistics. No source here records accidents in Chennai; that needs official records.</li>
</ul></div>

<h2>Sources</h2>
<div class="wrap"><table>
<tr><th>Source</th><th>Used for</th><th>How often</th><th>What is kept</th></tr>
<tr><td><b>TomTom</b> Routing API, live traffic</td><td>The record: minutes per stretch, TomTom's typical minutes for the moment, its no-traffic minutes, and where its route sees jams</td><td>Every 15 minutes, every road and direction</td><td>Every reading${retentionDays > 0 ? ` (raw for ${retentionDays} days, then daily summaries)` : ''}</td></tr>
<tr><td><b>Google</b> Routes API, live traffic</td><td>An independent check of the record</td><td>${google ? esc(hoursText) : 'not yet connected'}</td><td>Only the outcome of each comparison; Google's own times are not stored (its terms do not allow it)</td></tr>
<tr><td><b>TomTom</b> Traffic Incidents</td><td>Jams, closures, roadworks and any reported accidents or flooding across Chennai</td><td>Every 15 minutes</td><td>Each incident once, with first and last sighting</td></tr>
<tr><td><b>Open-Meteo</b> weather model</td><td>Hourly rainfall at one point per road</td><td>Hourly</td><td>Every hour${rainSince ? `, since ${esc(rainSince.slice(0, 10))}` : ''}</td></tr>
<tr><td><b>Tamil Nadu government</b> holiday list</td><td>Marking holidays on charts and reports</td><td>Set once a year</td><td>As notes</td></tr>
<tr><td><b>NDMA SACHET</b>, JTWC, Open-Meteo</td><td>Alerts for Tamil Nadu on the public page (not used in travel figures)</td><td>Every 10 minutes</td><td>The latest alerts only</td></tr>
</table></div>

<h2>How a reading is made</h2>
<p>For each road and direction, the service asks TomTom for the live-traffic drive through a fixed set of junctions. The junctions were snapped onto the road in the direction of travel when the road was set up, so every reading follows the same carriageway. Each reading gives the live minutes for every stretch between junctions, TomTom's typical minutes for that moment from its own history, and TomTom's no-traffic minutes. A reading is kept only if every stretch returned; one that strays more than 15% from the road's length is flagged as a detour.</p>

<h2>How the Google check works</h2>
${google ? `<p>${esc(hoursText.charAt(0).toUpperCase() + hoursText.slice(1))} (IST), straight after a TomTom reading, the service asks Google's Routes service for the same drive: the same junctions, each pinned to the direction of travel so Google uses the same carriageway, with live traffic. The two answers are then compared:</p>
<ul>
<li><b>Same moment:</b> the TomTom reading used is at most 10 minutes old.</li>
<li><b>Same road:</b> if Google's route is more than 10% longer or shorter than the road, the two are not describing the same drive; the check is counted as "route differs" and left out of the agreement figures.</li>
<li><b>Agreement:</b> TomTom's whole-road time within 10%, or within 20%, of Google's; otherwise which source was higher.</li>
<li><b>Congestion:</b> whether both sources saw the road as congested (live time at least 20% over that source's own no-traffic time).</li>
<li><b>Stretches:</b> how many of the stretches between junctions agree within 20%.</li>
</ul>
<p>Google Maps Platform's terms allow storing only map coordinates, for up to 30 days, so Google's travel times are discarded straight after the comparison; only the outcomes above are kept. Published travel times are always TomTom's. The check runs about 4,700 times a month, inside Google's free allowance, and stops for the month at ${esc(String(crosscheck?.cap ?? 4800))}.</p>` : '<p>A second traffic source (Google Routes) is being connected. Until it is, every travel time on this site rests on TomTom alone.</p>'}

<h2>How far each road can be trusted today</h2>
<div class="wrap"><table><tr><th>Road</th><th>Recorded</th><th>Day to day</th><th>Agreement with Google, last 30 days</th><th>Status</th><th>Formal use</th></tr>
${roads.map((r) => {
    const a = agree.get(r.corridor.id);
    const f = formalReadiness(r.confidence, a);
    return `<tr><td>${esc(r.corridor.name)}<div class="muted">${r.corridor.lengthKm} km · ${(r.corridor.definition?.sections || []).length} stretches</div></td><td>${r.days.weekdays} weekdays, ${r.days.weekendDays} weekend days<div class="muted">since ${esc(String(r.since || '—').slice(0, 10))}</div></td><td>${VARIES_LABEL[r.source.kind]}<div class="muted">${r.source.share == null ? 'needs two weekdays' : `${pct(r.source.share)} of half-hours differ by ${VARIES_MIN}+ min`}</div></td><td>${esc(agreementText(a))}${a?.route_differs ? `<div class="muted">${a.route_differs} check(s) left out: Google's route differed</div>` : ''}${a?.errors ? `<div class="muted">${a.errors} check(s) failed</div>` : ''}</td><td><span class="pill" style="background:${levelColour[r.confidence.level]}">${esc(r.confidence.level)}</span></td><td>${f.ready ? '<b>Yes</b>' : esc(f.text)}</td></tr>`;
  }).join('')}
</table></div>
<p class="muted"><b>Status</b>: early under ${CONFIDENCE.provisional} weekdays recorded, provisional from ${CONFIDENCE.provisional}, established from ${CONFIDENCE.established}. <b>Formal use</b>: established, and at least ${FORMAL.minChecks} Google comparisons with at least ${Math.round(FORMAL.minWithin20 * 100)}% within 20%. Findings that do not meet this are shown as early or provisional wherever they appear and are not for formal submissions.</p>

<h2>Definitions</h2>
<dl>
<dt>Typical</dt><dd>The median of all readings in the same 30-minute departure slot, weekdays and weekends kept apart.</dd>
<dt>Most days</dt><dd>The 10th to 90th percentile of the same slot: the range nine days in ten fall into.</dd>
<dt>Night-time drive</dt><dd>The quickest typical slot between midnight and 05:30. This is the reference for "extra" time. TomTom's no-traffic time is recorded but not used as the reference, because on these roads it is slower than real night drives.</dd>
<dt>Rush</dt><dd>The busiest slot in the morning (05:00–13:00) and in the afternoon and evening (13:00–24:00), and the span either side where the road stays at least 30% of the way from its night-time drive to that peak, found over the whole day, never inside a fixed window. The two spans meet at the quietest slot between the peaks; when even that midday low stays busy, the day is reported as one continuous busy period with two peaks.</dd>
<dt>Departure advice</dt><dd>Given only when leaving up to an hour earlier or later than the peak saves at least ${SHIFT_MIN_SAVING} minutes. Otherwise the page says there is no quick win.</dd>
<dt>Bottleneck</dt><dd>A stretch is named only if it carries at least a third of the extra time at the peak and at least one and a half times as much as the next stretch. Otherwise the delay is described as spread along the road.</dd>
<dt>Unusual now</dt><dd>The live drive is at least 5 minutes and 12% over typical for this slot, or more than 3 minutes above its "most days" range.</dd>
<dt>Day to day</dt><dd>TomTom's "live" time falls back on its historical pattern where it has little live data, and a pattern repeats itself every day. Each road is tested on the share of weekday half-hour slots, recorded on at least two weekdays, whose drive differed between days by ${VARIES_MIN} minutes or more. ${Math.round(SOURCE_LEVELS.live * 100)}% or more: varies day to day (live). ${Math.round(SOURCE_LEVELS.partly * 100)}–${Math.round(SOURCE_LEVELS.live * 100)}%: partly live. Below ${Math.round(SOURCE_LEVELS.partly * 100)}%: mostly TomTom's pattern.</dd>
<dt>Agreement</dt><dd>Of the Google checks where both sources drove the same road, the share where TomTom's whole-road time was within 10% (or 20%) of Google's at the same moment.</dd>
<dt>Recurring jam</dt><dd>A place (about 330 m across) where TomTom reports a major jam (magnitude 3 or 4, or at least 5 minutes of delay) on two or more days.</dd>
</dl>

<h2>Known limits</h2>
<ul>
<li><b>Two sources are not ground truth.</b> TomTom and Google both estimate traffic from phones and vehicles; where both have little live data, both lean on history, and agreement then shows consistency rather than accuracy. Timed drives on the ground are planned and not yet in place.</li>
<li><b>Google is a check, not a record.</b> Its terms do not allow its times to be stored, so every published travel time is TomTom's; Google contributes only agreement figures.</li>
<li><b>Some roads are mostly pattern.</b> Where the day-to-day test shows little variation, changes from one day to the next are not well observed. Those roads are labelled in the table above.</li>
<li><b>Different routes are left out.</b> Where Google prefers another way through the junctions (one-way streets, flyovers), the check is counted as "route differs" and not compared.</li>
<li><b>No accident record.</b> TomTom's incident feed for Chennai${incidentsSince ? ` since ${esc(incidentsSince.slice(0, 10))}` : ''} reports ${incidentCounts.length ? incidentCounts.map((c) => `${c.n} ${esc(c.category)}`).join(', ') : 'no incidents yet'}. Accident locations need official records (iRAD or the Traffic Police's blackspot list); nothing here is an accident statistic.</li>
<li><b>Rain is modelled</b> by Open-Meteo at one point per road, not measured by gauges.</li>
<li><b>15-minute sampling.</b> A jam shorter than a quarter hour can be missed; readings describe departures, not every minute of the road.</li>
</ul>

<h2>Licensing and retention</h2>
<div class="box">
<p><b>TomTom:</b> traffic data © TomTom, used under TomTom's developer terms, which allow commercial use and prohibit use for traffic-law enforcement such as choosing speed-camera sites. Those terms also limit how long downloaded traffic content may be kept. ${retentionDays > 0 ? `Raw readings are deleted after ${retentionDays} days; daily summaries by departure slot are kept.` : 'Raw readings are currently kept while that limit is confirmed with TomTom; daily summaries by departure slot are kept regardless.'}</p>
<p><b>Google:</b> Routes API under Google Maps Platform terms. Its service terms (section 19.3) allow caching only latitude and longitude, for up to 30 days. No Google travel time or distance is stored; only comparison outcomes are kept.</p>
<p>The summary export (one line per road, day and departure slot, TomTom-based) is ${exportPublic ? 'public at <a href="/export/slots.csv">/export/slots.csv</a>' : 'available on request while TomTom confirms its sharing terms'}.</p>
</div>

${notes.length ? `<h2>Events and changes on record</h2><div class="wrap"><table><tr><th>When (IST)</th><th>What</th></tr>${notes.map((n) => `<tr><td>${esc(new Date(Date.parse(n.at) + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' '))}</td><td>${esc(n.text)}</td></tr>`).join('')}</table></div>` : ''}

<h2>Method history</h2>
<ul>
<li><b>24–29 September 2026:</b> TomTom point speeds. On OMR those points shared a few long road segments, which hid local jams, so the method was retired.</li>
<li><b>29 September 2026, 11:30 IST:</b> section travel times on OMR, Anna Salai, GST Road and ECR, both directions. All findings rest on these.</li>
<li><b>1 October 2026:</b> findings rebuilt around rush shapes, ranges and the night-time drive; rainfall and holidays added; the Google check started (waypoints pinned to the direction of travel from its second hour).</li>
</ul>
</main></body></html>`;
}
