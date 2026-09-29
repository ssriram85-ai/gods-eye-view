/**
 * Weekly roads report: for each monitored road and direction, the week
 * just completed (Monday to Sunday, IST): how long the peaks took, when to
 * leave instead, which stretch carries the delay, how it compares with the
 * week before, plus the city's incidents and trouble spots. Email-safe
 * HTML (tables, inline styles, no SVG) so it reads in any mail client.
 */
import { travelProfile, commuterTips, istSlot, dayType } from './insights.mjs';
import { hotspots } from './incidents.mjs';

const IST_MIN = 330;
const DAY = 86_400_000;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Weekday peak periods, in minutes since midnight IST. */
export const PERIODS = Object.freeze([
  { id: 'morning', label: 'Morning peak', hours: '07:30–10:30', from: 450, to: 630 },
  { id: 'evening', label: 'Evening peak', hours: '16:30–20:30', from: 990, to: 1230 },
]);

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

/** Mean whole-corridor minutes of complete weekday samples inside a period. */
function periodStats(rows, sections, period) {
  const bySample = new Map();
  for (const r of rows) {
    if (r.travel_s == null) continue;
    const s = bySample.get(r.ts) || { ts: r.ts, travel: 0, free: 0, legs: [], n: 0 };
    s.travel += r.travel_s;
    s.free += r.no_traffic_s || 0;
    s.legs[r.leg] = r.travel_s - (r.no_traffic_s || 0);
    s.n++;
    bySample.set(r.ts, s);
  }
  const inside = [...bySample.values()].filter((s) => s.n === sections && dayType(s.ts) === 'weekday' && istSlot(s.ts, 15) >= period.from && istSlot(s.ts, 15) < period.to);
  if (!inside.length) return null;
  const minutes = inside.reduce((a, s) => a + s.travel, 0) / inside.length / 60;
  const free = inside.reduce((a, s) => a + s.free, 0) / inside.length / 60;
  const worst = inside.reduce((w, s) => (s.travel > w.travel ? s : w));
  const extraByLeg = Array.from({ length: sections }, (_, i) => inside.reduce((a, s) => a + (s.legs[i] || 0), 0) / inside.length / 60);
  const byDay = new Map();
  for (const s of inside) {
    const d = DAYS[(new Date(Date.parse(s.ts) + IST_MIN * 60_000).getUTCDay() + 6) % 7];
    const b = byDay.get(d) || { day: d, n: 0, travel: 0 };
    b.n++;
    b.travel += s.travel;
    byDay.set(d, b);
  }
  const days = [...byDay.values()].map((b) => ({ day: b.day, minutes: b.travel / b.n / 60 }));
  return { minutes, freeMinutes: free, worstMinutes: worst.travel / 60, worstAt: worst.ts, extraByLeg, days, samples: inside.length };
}

/** Summarize one corridor for one week, with the previous week for comparison. */
export function summarizeWeek({ travel, corridor, week, prev = previousWeek(week) }) {
  const sections = corridor.definition?.sections || [];
  const rows = travel.rows(corridor.id, week.start, week.end);
  const prevRows = prev ? travel.rows(corridor.id, prev.start, prev.end) : [];
  const samples = new Set(rows.map((r) => r.ts)).size;
  const profile = travelProfile(rows, { sections: sections.length });
  const { tips, enoughData } = commuterTips(corridor, profile, { minDays: 2 });
  const periods = PERIODS.map((p) => {
    const now = periodStats(rows, sections.length, p);
    const before = periodStats(prevRows, sections.length, p);
    const top = now ? now.extraByLeg.map((x, i) => ({ i, x })).sort((a, b) => b.x - a.x)[0] : null;
    return {
      ...p,
      minutes: now?.minutes ?? null,
      freeMinutes: now?.freeMinutes ?? null,
      worstMinutes: now?.worstMinutes ?? null,
      worstAt: now?.worstAt ?? null,
      previousMinutes: before?.minutes ?? null,
      changeMinutes: now && before ? now.minutes - before.minutes : null,
      worstDay: now?.days.length ? now.days.reduce((w, d) => (d.minutes > w.minutes ? d : w)) : null,
      bottleneck: top && sections[top.i] && top.x >= 1 ? { section: `${sections[top.i].from} → ${sections[top.i].to}`, extraMinutes: top.x } : null,
    };
  });
  const jams = travel.jams(corridor.id, week.start, week.end).filter((j) => j.category === 'jam');
  const jamBySection = new Map();
  for (const j of jams) if (j.leg != null) jamBySection.set(j.leg, (jamBySection.get(j.leg) || 0) + 1);
  const mostJammed = [...jamBySection.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    corridor: { id: corridor.id, name: corridor.name, lengthKm: corridor.lengthKm, road: corridor.definition?.road },
    week,
    samples,
    coverage: Math.min(1, samples / (7 * 96)),
    periods,
    tips,
    enoughData,
    jamReports: jams.length,
    mostJammed: mostJammed && sections[mostJammed[0]] ? { section: `${sections[mostJammed[0]].from} → ${sections[mostJammed[0]].to}`, reports: mostJammed[1] } : null,
  };
}

/** City-wide incident summary for the week, and trouble spots over the last 30 days. */
export function summarizeCity({ incidents, week }) {
  if (!incidents) return null;
  const counts = incidents.counts(week.start).filter((c) => c.n);
  const inWeek = incidents.since(week.start).filter((i) => i.first_seen < week.end);
  const accidents = inWeek.filter((i) => i.category === 'accident');
  const spots = hotspots(incidents.since(new Date(Date.parse(week.end) - 30 * DAY).toISOString()), { limit: 8 });
  return { counts, accidents: accidents.length, flooding: inWeek.filter((i) => i.category === 'flooding').length, hotspots: spots, since: incidents.firstSeen() };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const m = (v) => (v == null ? '—' : `${Math.round(v)} min`);
const signedMin = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)} min`);
const tone = (v) => (v == null ? '#555' : v >= 3 ? '#c0392b' : v <= -3 ? '#1e8449' : '#555');
const istTime = (iso) => new Date(Date.parse(iso) + IST_MIN * 60_000).toISOString().slice(11, 16);
const istDay = (iso) => DAYS[(new Date(Date.parse(iso) + IST_MIN * 60_000).getUTCDay() + 6) % 7];

/** One sentence per corridor that a commissioner can read without the table. */
export function headline(s) {
  if (!s.samples) return `${s.corridor.name}: no readings this week.`;
  const eve = s.periods.find((p) => p.id === 'evening'), morn = s.periods.find((p) => p.id === 'morning');
  const peak = [morn, eve].filter((p) => p?.minutes != null).sort((a, b) => b.minutes - a.minutes)[0];
  if (!peak) return `${s.corridor.name}: ${s.samples} readings, no complete weekday peak yet.`;
  const parts = [`${peak.label.toLowerCase()} averaged ${m(peak.minutes)} for ${s.corridor.lengthKm} km (${m(peak.freeMinutes)} on an empty road)`];
  if (peak.worstMinutes != null) parts.push(`worst ${m(peak.worstMinutes)} on ${istDay(peak.worstAt)} at ${istTime(peak.worstAt)}`);
  if (peak.changeMinutes != null) parts.push(`${Math.abs(Math.round(peak.changeMinutes)) < 1 ? 'same as' : `${signedMin(peak.changeMinutes)} vs`} last week`);
  return `${s.corridor.name}: ${parts.join('; ')}.`;
}

/** Email-safe HTML for the week. */
export function renderWeeklyHtml({ summaries, city, notes = [], week, baseUrl = '', generatedAt = new Date() }) {
  const td = 'padding:6px 8px;border-bottom:1px solid #e3e3e3;text-align:right;white-space:nowrap';
  const th = `${td};font-weight:600;color:#555;background:#f4f5f7`;
  const link = (s) => (baseUrl ? `<a href="${esc(baseUrl)}/corridors/${esc(s.corridor.id)}/report?hours=168" style="color:#1a5fb4">live report</a>` : '');
  const section = (s) => `
<div style="margin:0 0 26px">
<h3 style="font-size:15px;margin:0 0 4px;color:#111">${esc(s.corridor.name)}</h3>
<p style="margin:0 0 8px;color:#333">${esc(headline(s))}</p>
${s.tips.length ? `<ul style="margin:0 0 8px;padding-left:18px;color:#333">${s.tips.map((t) => `<li style="margin:0 0 3px">${esc(t.text)}</li>`).join('')}</ul>` : `<p style="margin:0 0 8px;color:#777;font-size:13px">Not enough days recorded yet for departure-time advice.</p>`}
<table style="border-collapse:collapse;width:100%;font-size:13px" cellpadding="0" cellspacing="0">
<tr><th style="${th};text-align:left">Weekdays</th><th style="${th}">This week</th><th style="${th}">Worst</th><th style="${th}">Last week</th><th style="${th}">Change</th><th style="${th}">Empty road</th><th style="${th};text-align:left">Most delay</th></tr>
${s.periods.map((p) => `<tr><td style="${td};text-align:left">${p.label} <span style="color:#888">${p.hours}</span></td><td style="${td}">${m(p.minutes)}</td><td style="${td}">${p.worstAt ? `${m(p.worstMinutes)} <span style="color:#888">${istDay(p.worstAt)} ${istTime(p.worstAt)}</span>` : '—'}</td><td style="${td}">${m(p.previousMinutes)}</td><td style="${td};color:${tone(p.changeMinutes)};font-weight:600">${signedMin(p.changeMinutes)}</td><td style="${td}">${m(p.freeMinutes)}</td><td style="${td};text-align:left">${p.bottleneck ? `${esc(p.bottleneck.section)} <span style="color:#888">+${Math.round(p.bottleneck.extraMinutes)}</span>` : '—'}</td></tr>`).join('')}
</table>
<p style="margin:6px 0 0;color:#777;font-size:12px">${s.samples} readings (${Math.round(s.coverage * 100)}% of every-15-minutes)${s.mostJammed ? ` · TomTom reported jams most often on ${esc(s.mostJammed.section)} (${s.mostJammed.reports}×)` : ''} ${link(s)}</p>
</div>`;
  const cityBlock = city
    ? `<h2 style="font-size:17px;margin:28px 0 6px">Chennai incidents</h2>
<p style="margin:0 0 8px;color:#333">This week: ${city.counts.map((c) => `${c.n} ${esc(c.category)}`).join(', ') || 'none recorded'}.${city.accidents ? ` <b>${city.accidents} accident report${city.accidents > 1 ? 's' : ''}.</b>` : ''}${city.flooding ? ` ${city.flooding} flooding report${city.flooding > 1 ? 's' : ''}.` : ''}</p>
${city.hotspots.length ? `<p style="margin:0 0 6px;color:#333">Trouble spots, last 30 days (where accidents, breakdowns, flooding and major jams keep being reported):</p>
<table style="border-collapse:collapse;width:100%;font-size:13px" cellpadding="0" cellspacing="0"><tr><th style="${th};text-align:left">Place</th><th style="${th}">Reports</th><th style="${th}">Days</th><th style="${th};text-align:left">What</th><th style="${th}">Map</th></tr>
${city.hotspots.map((h) => `<tr><td style="${td};text-align:left;white-space:normal">${esc(h.place || 'unnamed road')}</td><td style="${td}">${h.reports}</td><td style="${td}">${h.days}</td><td style="${td};text-align:left">${Object.entries(h.kinds).map(([k, n]) => `${n} ${esc(k)}`).join(', ')}</td><td style="${td}"><a href="https://www.google.com/maps?q=${h.lat},${h.lon}" style="color:#1a5fb4">open</a></td></tr>`).join('')}</table>` : `<p style="margin:0;color:#777;font-size:13px">No trouble spots yet; they appear as incident reports accumulate${city.since ? ` (recording since ${esc(city.since.slice(0, 10))})` : ''}.</p>`}`
    : '';
  const roads = [...new Set(summaries.map((s) => s.corridor.road))];
  const roadName = { omr: 'OMR (Rajiv Gandhi Salai)', 'anna-salai': 'Anna Salai (Mount Road)', gst: 'GST Road', ecr: 'ECR (East Coast Road)' };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chennai roads · week ${esc(week.key)}</title></head>
<body style="margin:0;padding:20px;background:#fff;color:#111;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:760px;margin:0 auto">
<h1 style="font-size:20px;margin:0 0 2px">Chennai roads · week ${esc(week.key)}</h1>
<p style="margin:0 0 18px;color:#777">${esc(week.label)} (Monday to Sunday, IST) · generated ${esc(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC${baseUrl ? ` · <a href="${esc(baseUrl)}/" style="color:#1a5fb4">live page</a>` : ''}</p>
${roads.map((r) => `<h2 style="font-size:17px;margin:22px 0 8px">${esc(roadName[r] || r || 'Roads')}</h2>${summaries.filter((s) => s.corridor.road === r).map(section).join('')}`).join('')}
${cityBlock}
${notes.length ? `<h2 style="font-size:17px;margin:28px 0 6px">Notes</h2><ul style="padding-left:18px;color:#333">${notes.map((n) => `<li>${esc(n.at.slice(0, 10))}: ${esc(n.text)}</li>`).join('')}</ul>` : ''}
<p style="color:#777;font-size:12px;margin-top:24px">Travel times are TomTom live-traffic routing along each road, sampled every 15 minutes and split at the named junctions. "Empty road" is TomTom's no-traffic time for the same route, which still includes signals. Trouble spots count TomTom incident reports near the same place; they show where trouble recurs, they are not official accident statistics. Traffic data © TomTom.</p>
</div></body></html>`;
}

/** Plain-text twin for the email's text part. */
export function renderWeeklyText({ summaries, city, week, baseUrl = '' }) {
  return [
    `Chennai roads, week ${week.key} (${week.label}, IST)`,
    '',
    ...summaries.flatMap((s) => [headline(s), ...s.tips.map((t) => `  - ${t.text}`), '']),
    city ? `Incidents this week: ${city.counts.map((c) => `${c.n} ${c.category}`).join(', ') || 'none'}` : '',
    ...(city?.hotspots || []).slice(0, 5).map((h) => `  Trouble spot: ${h.place || 'unnamed road'} (${h.reports} reports on ${h.days} days) https://www.google.com/maps?q=${h.lat},${h.lon}`),
    '',
    baseUrl ? `Live page: ${baseUrl}/` : '',
    'Traffic data (c) TomTom.',
  ].join('\n');
}
