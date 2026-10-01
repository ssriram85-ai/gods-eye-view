/**
 * Weekly roads report: for each monitored road and direction, the week
 * just completed (Monday to Sunday, IST). Rush windows and advice come from
 * everything recorded so far (more days, firmer findings); the week's own
 * figures are the typical and bad-day drive inside those windows, compared
 * with the week before, with the week's rain and its effect. Findings are
 * split into established ones and early observations, so nothing thin is
 * passed off as firm. Email-safe HTML (tables, inline styles, no SVG).
 */
import { travelProfile, commuterTips, crossRoadNotes, samplesOf, istSlot, dayType, daysCovered, confidenceOf, sourceOf, quantile } from './insights.mjs';
import { safetySpots, recurringJams } from './incidents.mjs';
import { rainAt } from './weather.mjs';
import { agreementText } from './crosscheck.mjs';

const IST_MIN = 330;
const DAY = 86_400_000;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];


const localDay = (ms) => Math.floor((ms + IST_MIN * 60_000) / DAY);
const toUtcIso = (localMs) => new Date(localMs - IST_MIN * 60_000).toISOString();

/** ISO 8601 week key ("2026-W39") for an IST-local Monday given in the local frame. */
export function isoWeekKey(mondayLocalMs) {
  const thursday = new Date(mondayLocalMs + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const week = Math.round((mondayLocalMs - week1Monday) / (7 * DAY)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Bounds of the ISO week with this key, as UTC instants of IST midnight. */
export function weekBounds(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const year = Number(m[1]), week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const mondayLocal = week1Monday + (week - 1) * 7 * DAY;
  return {
    key,
    start: toUtcIso(mondayLocal),
    end: toUtcIso(mondayLocal + 7 * DAY),
    label: `${new Date(mondayLocal).toISOString().slice(0, 10)} → ${new Date(mondayLocal + 6 * DAY).toISOString().slice(0, 10)}`,
  };
}

/** The most recent week that has fully ended, IST, as of `atMs`. */
export function lastCompletedWeek(atMs = Date.now()) {
  const today = localDay(atMs) * DAY;
  const thisMonday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  return weekBounds(isoWeekKey(thisMonday - 7 * DAY));
}

export function previousWeek(week) {
  return weekBounds(isoWeekKey(Date.parse(week.start) + IST_MIN * 60_000 - 7 * DAY));
}

const pctl = (xs, q) => quantile([...xs].sort((a, b) => a - b), q);

/** Weekday samples inside a rush window [start, end) (minutes since IST midnight). */
function windowStats(samples, start, end) {
  const inside = samples.filter((s) => dayType(s.ts) === 'weekday' && istSlot(s.ts, 15) >= start && istSlot(s.ts, 15) < end);
  if (!inside.length) return null;
  const totals = inside.map((s) => s.travel / 60);
  const worst = inside.reduce((w, s) => (s.travel > w.travel ? s : w));
  return { samples: inside.length, typical: pctl(totals, 0.5), bad: pctl(totals, 0.9), worstMinutes: worst.travel / 60, worstAt: worst.ts };
}

/**
 * Summarize one corridor for one week. `history` are all rows up to the
 * week's end (used for rush windows, advice, source and confidence);
 * the week's and the previous week's rows give the week-on-week figures.
 */
export function summarizeWeek({ travel, corridor, week, prev = previousWeek(week), rain = null, historyDays = 28 }) {
  const sections = corridor.definition?.sections?.length || 0;
  const history = travel.rows(corridor.id, new Date(Date.parse(week.end) - historyDays * DAY).toISOString(), week.end);
  const rows = history.filter((r) => r.ts >= week.start);
  const prevRows = prev ? travel.rows(corridor.id, prev.start, prev.end) : [];
  const weekSamples = samplesOf(rows, sections);
  const prevSamples = samplesOf(prevRows, sections);
  const profile = travelProfile(history, { sections });
  const advice = commuterTips(corridor, profile, { minDays: 2 });
  const days = daysCovered(history);
  const confidence = confidenceOf(days.weekdays);
  const source = sourceOf(history, sections);
  const periods = (advice.rushes || []).filter((r) => !r.none).map((r) => {
    const now = windowStats(weekSamples, r.start, r.end);
    const before = windowStats(prevSamples, r.start, r.end);
    return {
      period: r.period,
      window: `${r.startLabel}–${r.endLabel}`,
      peakAt: r.peak.label,
      typical: now?.typical ?? null,
      bad: now?.bad ?? null,
      worstMinutes: now?.worstMinutes ?? null,
      worstAt: now?.worstAt ?? null,
      previousTypical: before?.typical ?? null,
      change: now && before ? now.typical - before.typical : null,
      samples: now?.samples || 0,
    };
  });
  // Rain: the week's total and, where it rained, how much slower the drive was than typical for that slot.
  let rainSummary = null;
  if (rain) {
    let mm = 0, wetHours = 0;
    for (const [hour, v] of rain) if (hour >= week.start && hour < week.end) (mm += v), v >= 2.5 && wetHours++;
    const bySlot = new Map(profile[ 'weekday' ].map((p) => [p.slot, p]));
    const wet = weekSamples.filter((s) => (rainAt(rain, s.ts) ?? 0) >= 2.5 && dayType(s.ts) === 'weekday' && bySlot.get(istSlot(s.ts))?.days >= 2);
    const excess = wet.map((s) => s.travel / 60 - bySlot.get(istSlot(s.ts)).minutes);
    rainSummary = { mm, wetHours, wetSamples: wet.length, excessMinutes: excess.length >= 3 ? pctl(excess, 0.5) : null };
  }
  const jams = travel.jams(corridor.id, week.start, week.end).filter((j) => j.category === 'jam');
  const jamBySection = new Map();
  for (const j of jams) if (j.leg != null) jamBySection.set(j.leg, (jamBySection.get(j.leg) || 0) + 1);
  const mostJammed = [...jamBySection.entries()].sort((a, b) => b[1] - a[1])[0];
  const secs = corridor.definition?.sections || [];
  return {
    corridor: { id: corridor.id, name: corridor.name, lengthKm: corridor.lengthKm, road: corridor.definition?.road },
    week,
    samples: weekSamples.length,
    coverage: Math.min(1, weekSamples.length / (7 * 96)),
    baselineMinutes: advice.baseline?.minutes ?? null,
    periods,
    tips: advice.tips,
    rushes: advice.rushes,
    enoughData: advice.enoughData,
    confidence,
    source,
    days,
    rain: rainSummary,
    jamReports: jams.length,
    mostJammed: mostJammed && secs[mostJammed[0]] ? { section: `${secs[mostJammed[0]].from} → ${secs[mostJammed[0]].to}`, reports: mostJammed[1] } : null,
  };
}

/** Add notes that only make sense across roads (morning-peaking roads, directions peaking apart). */
export function addCrossRoadNotes(summaries) {
  const notes = crossRoadNotes(summaries.map((s) => ({ corridor: { id: s.corridor.id, name: s.corridor.name, definition: { road: s.corridor.road, direction: s.corridor.name.split(' ')[s.corridor.name.split(' ').findIndex((w) => /bound$/.test(w))] } }, rushes: s.rushes })));
  for (const s of summaries) s.notes = notes.get(s.corridor.id) || [];
  return summaries;
}

/** City-wide incident summary for the week: counts, recurring jams, safety spots (last 30 days). */
export function summarizeCity({ incidents, week }) {
  if (!incidents) return null;
  const counts = incidents.counts(week.start).filter((c) => c.n);
  const inWeek = incidents.since(week.start).filter((i) => i.first_seen < week.end);
  const last30 = incidents.since(new Date(Date.parse(week.end) - 30 * DAY).toISOString());
  return {
    counts,
    accidents: inWeek.filter((i) => i.category === 'accident').length,
    flooding: inWeek.filter((i) => i.category === 'flooding').length,
    recurring: recurringJams(last30, { limit: 8 }),
    safety: safetySpots(last30, { limit: 8 }),
    since: incidents.firstSeen(),
  };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const m = (v) => (v == null ? '—' : `${Math.round(v)} min`);
const signedMin = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)} min`);
const tone = (v) => (v == null ? '#555' : v >= 3 ? '#c0392b' : v <= -3 ? '#1e8449' : '#555');
const istTime = (iso) => new Date(Date.parse(iso) + IST_MIN * 60_000).toISOString().slice(11, 16);
const istDay = (iso) => DAYS[(new Date(Date.parse(iso) + IST_MIN * 60_000).getUTCDay() + 6) % 7];

/** One sentence per corridor that an official can read without the table. */
export function headline(s) {
  if (!s.samples) return `${s.corridor.name}: no readings this week.`;
  const worst = [...s.periods].sort((a, b) => (b.typical ?? 0) - (a.typical ?? 0))[0];
  if (!worst || worst.typical == null) return `${s.corridor.name}: ${s.samples} readings; rush windows not established yet.`;
  const parts = [`${worst.period} rush ${worst.window}, worst around ${worst.peakAt}, typically ${m(worst.typical)} (${m(worst.bad)} on a bad day) for ${s.corridor.lengthKm} km`];
  if (s.baselineMinutes != null) parts.push(`${m(s.baselineMinutes)} at night`);
  if (worst.change != null) parts.push(Math.abs(worst.change) < 1 ? 'unchanged on last week' : `${signedMin(worst.change)} on last week`);
  return `${s.corridor.name}: ${parts.join('; ')}.`;
}

const ROAD_NAME = { omr: 'OMR (Rajiv Gandhi Salai)', 'anna-salai': 'Anna Salai (Mount Road)', gst: 'GST Road', ecr: 'ECR (East Coast Road)' };

/** Email-safe HTML for the week. */
export function renderWeeklyHtml({ summaries, city, notes = [], week, baseUrl = '', generatedAt = new Date() }) {
  const td = 'padding:6px 8px;border-bottom:1px solid #e3e3e3;text-align:right;white-space:nowrap';
  const th = `${td};font-weight:600;color:#555;background:#f4f5f7`;
  const tag = (text, bg) => `<span style="display:inline-block;background:${bg};color:#fff;border-radius:10px;padding:1px 8px;font-size:11px;margin-right:4px">${esc(text)}</span>`;
  const levelBg = { established: '#1e8449', provisional: '#b7950b', early: '#7f8c8d' };
  const link = (s) => (baseUrl ? `<a href="${esc(baseUrl)}/corridors/${esc(s.corridor.id)}/report?hours=168" style="color:#1a5fb4">live report</a>` : '');
  const findings = (s) => {
    const list = s.tips.map((t) => t.text).concat(s.notes || []);
    if (!list.length) return `<p style="margin:0 0 8px;color:#777;font-size:13px">Rush windows and advice appear once each half-hour has been recorded on two weekdays.</p>`;
    const firm = s.confidence.level === 'established';
    return `<p style="margin:0 0 4px;font-size:13px;font-weight:600;color:${firm ? '#1e8449' : '#7f6000'}">${firm ? 'Findings' : `Early observations, not for formal use (${esc(s.confidence.text)})`}</p><ul style="margin:0 0 8px;padding-left:18px;color:#333">${list.map((t) => `<li style="margin:0 0 3px">${esc(t)}</li>`).join('')}</ul>`;
  };
  const section = (s) => `
<div style="margin:0 0 26px">
<h3 style="font-size:15px;margin:0 0 4px;color:#111">${esc(s.corridor.name)}</h3>
<p style="margin:0 0 6px">${tag({ observed: 'Varies day to day (live)', partly: 'Partly live', modelled: "Mostly TomTom's pattern", unknown: 'Source not yet known' }[s.source.kind], { observed: '#1a5fb4', partly: '#5d6d7e', modelled: '#7f8c8d', unknown: '#7f8c8d' }[s.source.kind])}${tag(s.confidence.level, levelBg[s.confidence.level])}</p>
<p style="margin:0 0 8px;color:#333">${esc(headline(s))}</p>
${findings(s)}
${s.periods.length ? `<table style="border-collapse:collapse;width:100%;font-size:13px" cellpadding="0" cellspacing="0">
<tr><th style="${th};text-align:left">Weekday rush</th><th style="${th}">Typical</th><th style="${th}">Bad day</th><th style="${th}">Worst</th><th style="${th}">Last week</th><th style="${th}">Change</th></tr>
${s.periods.map((p) => `<tr><td style="${td};text-align:left">${p.period === 'morning' ? 'Morning' : 'Evening'} <span style="color:#888">${esc(p.window)}</span></td><td style="${td}">${m(p.typical)}</td><td style="${td}">${m(p.bad)}</td><td style="${td}">${p.worstAt ? `${m(p.worstMinutes)} <span style="color:#888">${istDay(p.worstAt)} ${istTime(p.worstAt)}</span>` : '—'}</td><td style="${td}">${m(p.previousTypical)}</td><td style="${td};color:${tone(p.change)};font-weight:600">${signedMin(p.change)}</td></tr>`).join('')}
</table>` : ''}
<p style="margin:6px 0 0;color:#777;font-size:12px">${s.samples} readings this week (${Math.round(s.coverage * 100)}% of every-15-minutes) · ${esc(s.source.text)}${s.rain ? ` · rain ${s.rain.mm.toFixed(0)} mm, ${s.rain.wetHours} wet hour${s.rain.wetHours === 1 ? '' : 's'}${s.rain.excessMinutes != null ? `, wet-hour drives ${signedMin(s.rain.excessMinutes)} vs typical` : ''}` : ''}${s.mostJammed ? ` · TomTom reported jams most often on ${esc(s.mostJammed.section)} (${s.mostJammed.reports}×)` : ''}${s.agreement?.compared ? ` · second source: ${esc(agreementText(s.agreement))}` : ''} ${link(s)}</p>
</div>`;
  const cityBlock = city
    ? `<h2 style="font-size:17px;margin:28px 0 6px">Chennai incidents</h2>
<p style="margin:0 0 8px;color:#333">This week TomTom reported ${city.counts.map((c) => `${c.n} ${esc(c.category)}`).join(', ') || 'no incidents'}.${city.accidents ? ` <b>${city.accidents} accident report${city.accidents > 1 ? 's' : ''}.</b>` : ' No accidents were reported; TomTom carries almost no accident data for Chennai.'}</p>
${city.recurring.length ? `<p style="margin:0 0 6px;color:#333">Recurring jams, last 30 days (a major jam on two or more days):</p>
<table style="border-collapse:collapse;width:100%;font-size:13px" cellpadding="0" cellspacing="0"><tr><th style="${th};text-align:left">Place</th><th style="${th}">Days seen</th><th style="${th}">Typical delay</th><th style="${th}">Map</th></tr>
${city.recurring.map((h) => `<tr><td style="${td};text-align:left;white-space:normal">${esc(h.place || 'unnamed road')}</td><td style="${td}">${h.days}</td><td style="${td}">${h.typicalDelayMinutes != null ? `${h.typicalDelayMinutes} min` : '—'}</td><td style="${td}"><a href="https://www.google.com/maps?q=${h.lat},${h.lon}" style="color:#1a5fb4">open</a></td></tr>`).join('')}</table>` : ''}
${city.safety.length ? `<p style="margin:10px 0 6px;color:#333">Accident, breakdown and flooding spots:</p><ul>${city.safety.map((h) => `<li>${esc(h.place || 'unnamed road')}: ${Object.entries(h.kinds).map(([k, n]) => `${n} ${esc(k)}`).join(', ')}</li>`).join('')}</ul>` : ''}`
    : '';
  const roads = [...new Set(summaries.map((s) => s.corridor.road))];
  const established = summaries.filter((s) => s.confidence.level === 'established').length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chennai roads · week ${esc(week.key)}</title></head>
<body style="margin:0;padding:20px;background:#fff;color:#111;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:760px;margin:0 auto">
<h1 style="font-size:20px;margin:0 0 2px">Chennai roads · week ${esc(week.key)}</h1>
<p style="margin:0 0 6px;color:#777">${esc(week.label)} (Monday to Sunday, IST) · generated ${esc(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC${baseUrl ? ` · <a href="${esc(baseUrl)}/" style="color:#1a5fb4">live page</a> · <a href="${esc(baseUrl)}/methodology" style="color:#1a5fb4">method and limits</a>` : ''}</p>
<p style="margin:0 0 18px;color:#333;font-size:13px">${established === summaries.length ? 'All roads have enough weekdays recorded for established findings.' : `${established} of ${summaries.length} road directions have established findings; the rest are early observations and are labelled as such.`}</p>
${roads.map((r) => `<h2 style="font-size:17px;margin:22px 0 8px">${esc(ROAD_NAME[r] || r || 'Roads')}</h2>${summaries.filter((s) => s.corridor.road === r).map(section).join('')}`).join('')}
${cityBlock}
${notes.length ? `<h2 style="font-size:17px;margin:28px 0 6px">Events on record this week</h2><ul style="padding-left:18px;color:#333">${notes.map((n) => `<li>${esc(new Date(Date.parse(n.at) + IST_MIN * 60_000).toISOString().slice(0, 16).replace('T', ' '))}: ${esc(n.text)}</li>`).join('')}</ul>` : ''}
<p style="color:#777;font-size:12px;margin-top:24px">Travel times are TomTom live-traffic routing along each road every 15 minutes, split at the named junctions. "Typical" is the median and "bad day" the 90th percentile of weekday drives inside each rush window; rush windows and advice rest on all days recorded so far. Rain is Open-Meteo's hourly model at mid-road. Traffic data © TomTom.</p>
</div></body></html>`;
}

/** Plain-text twin for the email's text part. */
export function renderWeeklyText({ summaries, city, week, baseUrl = '' }) {
  return [
    `Chennai roads, week ${week.key} (${week.label}, IST)`,
    '',
    ...summaries.flatMap((s) => [`${headline(s)} [${{ observed: 'varies day to day', partly: 'partly live', modelled: "mostly TomTom's pattern", unknown: 'source not yet known' }[s.source.kind]}; ${s.confidence.level}]`, ...s.tips.map((t) => `  - ${t.text}`), '']),
    city ? `Incidents this week: ${city.counts.map((c) => `${c.n} ${c.category}`).join(', ') || 'none'}` : '',
    ...(city?.recurring || []).slice(0, 5).map((h) => `  Recurring jam: ${h.place || 'unnamed road'} (${h.days} days, typical delay ${h.typicalDelayMinutes ?? '?'} min) https://www.google.com/maps?q=${h.lat},${h.lon}`),
    '',
    baseUrl ? `Live page: ${baseUrl}/   Method and limits: ${baseUrl}/methodology` : '',
    'Traffic data (c) TomTom.',
  ].join('\n');
}
