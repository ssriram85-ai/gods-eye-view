/**
 * Weekly corridor summary: the week just completed (Monday to Sunday, IST)
 * against everything recorded before it, by time of day. Rendered as
 * email-safe HTML (tables, inline styles, no SVG) so it reads in Gmail.
 */
import { profile, compareProfiles } from './corridor.mjs';

const IST_MIN = 330;
const DAY = 86_400_000;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Periods of the day, in minutes since midnight IST. */
export const PERIODS = Object.freeze([
  { id: 'morning', label: 'Morning peak', hours: '07:30–10:30', from: 450, to: 630 },
  { id: 'midday', label: 'Midday', hours: '10:30–16:30', from: 630, to: 990 },
  { id: 'evening', label: 'Evening peak', hours: '16:30–20:30', from: 990, to: 1230 },
  { id: 'night', label: 'Night', hours: '20:30–07:30', from: 1230, to: 450 },
]);

const inPeriod = (slot, p) => (p.from < p.to ? slot >= p.from && slot < p.to : slot >= p.from || slot < p.to);
const localDay = (ms) => Math.floor((ms + IST_MIN * 60_000) / DAY); // IST calendar day number
const toUtcIso = (localMs) => new Date(localMs - IST_MIN * 60_000).toISOString();

/** ISO 8601 week key ("2026-W39") for the IST-local Monday given as ms-since-epoch in local frame. */
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
  return { key, start: toUtcIso(mondayLocal), end: toUtcIso(mondayLocal + 7 * DAY), label: `${new Date(mondayLocal).toISOString().slice(0, 10)} → ${new Date(mondayLocal + 6 * DAY).toISOString().slice(0, 10)}` };
}

/** The most recent week that has fully ended, IST, as of `atMs`. */
export function lastCompletedWeek(atMs = Date.now()) {
  const today = localDay(atMs) * DAY; // IST midnight today, local frame
  const thisMonday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  return weekBounds(isoWeekKey(thisMonday - 7 * DAY));
}

/** Corridor travel time estimate: length ÷ mean sampled speed, in seconds. */
const travelS = (lengthKm, speedKmh) => (lengthKm && speedKmh ? (lengthKm / speedKmh) * 3600 : null);

const mean = (rows, key, weight = 'samples') => {
  let n = 0, s = 0;
  for (const r of rows) {
    if (r[key] == null) continue;
    const w = r[weight] || 1;
    n += w;
    s += r[key] * w;
  }
  return n ? s / n : null;
};

/** Summarize one corridor for one week against all earlier samples. */
export function summarizeWeek({ store, corridor, week }) {
  const weekRows = store.series(corridor.id, week.start, week.end);
  const baselineRows = store.series(corridor.id, '2000-01-01T00:00:00.000Z', week.start);
  const weekProfile = profile(weekRows);
  const baselineProfile = profile(baselineRows);
  const comparison = baselineProfile.length && weekProfile.length ? compareProfiles(baselineProfile, weekProfile) : null;

  const periods = PERIODS.map((p) => {
    const w = weekProfile.filter((s) => inPeriod(s.slot, p));
    const b = baselineProfile.filter((s) => inPeriod(s.slot, p));
    const ratio = mean(w, 'speedRatio'), base = mean(b, 'speedRatio');
    return { ...p, speedRatio: ratio, travelTimeS: travelS(corridor.lengthKm, mean(w, 'meanSpeed')), baselineRatio: base, baselineTravelTimeS: travelS(corridor.lengthKm, mean(b, 'meanSpeed')),
      changePoints: ratio != null && base != null ? Math.round((ratio - base) * 100) : null, samples: w.reduce((n, s) => n + s.samples, 0) };
  });

  const byDay = new Map();
  for (const r of weekRows) {
    if (r.speed_ratio == null) continue;
    const day = DAYS[(new Date(Date.parse(r.ts) + IST_MIN * 60_000).getUTCDay() + 6) % 7];
    const b = byDay.get(day) || { day, n: 0, ratio: 0, speed: 0 };
    b.n++;
    b.ratio += r.speed_ratio;
    b.speed += r.mean_speed || 0;
    byDay.set(day, b);
  }
  const days = DAYS.map((day) => {
    const b = byDay.get(day);
    return { day, samples: b?.n || 0, speedRatio: b ? b.ratio / b.n : null, travelTimeS: b ? travelS(corridor.lengthKm, b.speed / b.n) : null };
  });
  const worstDay = days.filter((d) => d.speedRatio != null).reduce((w, d) => (w === null || d.speedRatio < w.speedRatio ? d : w), null);

  const expected = 7 * Math.round(DAY / (15 * 60_000));
  const first = baselineRows[0]?.ts || weekRows[0]?.ts || null;
  return {
    corridor: { id: corridor.id, name: corridor.name, lengthKm: corridor.lengthKm },
    week,
    samples: weekRows.length,
    coverage: Math.min(1, weekRows.length / expected),
    overall: { speedRatio: mean(weekProfile, 'speedRatio'), travelTimeS: travelS(corridor.lengthKm, mean(weekProfile, 'meanSpeed')), baselineRatio: mean(baselineProfile, 'speedRatio'), baselineTravelTimeS: travelS(corridor.lengthKm, mean(baselineProfile, 'meanSpeed')) },
    periods,
    days,
    worstDay,
    worstSlot: comparison?.worst || null,
    meanChangePoints: comparison?.meanChange == null ? null : Math.round(comparison.meanChange * 100),
    closures: weekRows.reduce((n, r) => n + (r.closures || 0), 0),
    baseline: baselineRows.length ? { samples: baselineRows.length, from: first, to: week.start } : null,
    notes: store.listNotes(corridor.id).filter((n) => n.at >= week.start && n.at < week.end),
  };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const mins = (s) => (s == null ? '—' : `${(s / 60).toFixed(1)} min`);
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}`);
const tone = (n) => (n == null ? '#555' : n <= -10 ? '#c0392b' : n >= 8 ? '#1e8449' : '#555');
const istDate = (iso) => new Date(Date.parse(iso) + IST_MIN * 60_000).toISOString().slice(0, 10);

/** One sentence a commissioner can read without the table. */
export function headline(s) {
  if (!s.samples) return `No readings were recorded for ${s.corridor.name} this week.`;
  const parts = [];
  const evening = s.periods.find((p) => p.id === 'evening'), morning = s.periods.find((p) => p.id === 'morning');
  const peak = [morning, evening].filter((p) => p?.speedRatio != null).sort((a, b) => a.speedRatio - b.speedRatio)[0];
  if (peak) parts.push(`${peak.label.toLowerCase()} ran at ${pct(peak.speedRatio)} of free-flow speed (${mins(peak.travelTimeS)} over ${s.corridor.lengthKm} km)`);
  if (s.meanChangePoints != null) {
    const dir = s.meanChangePoints > 0 ? 'faster' : s.meanChangePoints < 0 ? 'slower' : 'unchanged';
    parts.push(dir === 'unchanged' ? 'unchanged against the baseline' : `${Math.abs(s.meanChangePoints)} points ${dir} than the baseline across matching time slots`);
  } else parts.push('no earlier weeks yet to compare against');
  if (s.worstDay) parts.push(`worst day ${s.worstDay.day} at ${pct(s.worstDay.speedRatio)}`);
  return `${s.corridor.name}: ${parts.join('; ')}.`;
}

/** Email-safe HTML for one or more corridor summaries. */
export function renderWeeklyHtml({ summaries, week, baseUrl = '', generatedAt = new Date() }) {
  const link = (s) => {
    if (!baseUrl) return '';
    const q = s.baseline ? `?hours=168&a=${istDate(s.baseline.from)}..${istDate(new Date(Date.parse(week.start) - 1).toISOString())}&b=${istDate(week.start)}..${istDate(new Date(Date.parse(week.end) - 1).toISOString())}` : '?hours=168';
    return `<p style="margin:8px 0 0"><a href="${esc(baseUrl)}/corridors/${esc(s.corridor.id)}/report${esc(q)}" style="color:#1a5fb4">Open the live report for this corridor</a></p>`;
  };
  const td = 'padding:6px 8px;border-bottom:1px solid #e3e3e3;text-align:right;white-space:nowrap';
  const th = `${td};font-weight:600;color:#555;background:#f4f5f7`;
  const section = (s) => `
<div style="margin:0 0 28px">
<h2 style="font-size:17px;margin:0 0 4px;color:#111">${esc(s.corridor.name)}</h2>
<p style="margin:0 0 10px;color:#333">${esc(headline(s))}</p>
<p style="margin:0 0 10px;color:#777;font-size:12px">${s.samples} readings this week (${Math.round(s.coverage * 100)}% of the planned every-15-minutes coverage)${s.baseline ? ` · baseline ${s.baseline.samples} readings from ${istDate(s.baseline.from)}` : ''}${s.closures ? ` · ${s.closures} closure flags` : ''}</p>
<table style="border-collapse:collapse;width:100%;font-size:13px" cellpadding="0" cellspacing="0">
<tr><th style="${th};text-align:left">Period (IST)</th><th style="${th}">This week</th><th style="${th}">Baseline</th><th style="${th}">Change</th><th style="${th}">Travel, week</th><th style="${th}">Travel, baseline</th></tr>
${s.periods.map((p) => `<tr><td style="${td};text-align:left">${p.label} <span style="color:#888">${p.hours}</span></td><td style="${td}">${pct(p.speedRatio)}</td><td style="${td}">${pct(p.baselineRatio)}</td><td style="${td};color:${tone(p.changePoints)};font-weight:600">${signed(p.changePoints)}</td><td style="${td}">${mins(p.travelTimeS)}</td><td style="${td}">${mins(p.baselineTravelTimeS)}</td></tr>`).join('')}
</table>
<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:10px" cellpadding="0" cellspacing="0">
<tr>${s.days.map((d) => `<th style="${th}">${d.day}</th>`).join('')}</tr>
<tr>${s.days.map((d) => `<td style="${td};${s.worstDay && d.day === s.worstDay.day ? 'color:#c0392b;font-weight:600' : ''}">${pct(d.speedRatio)}</td>`).join('')}</tr>
</table>
${s.worstSlot ? `<p style="margin:10px 0 0;color:#333;font-size:13px">Worst time slot against baseline: <b>${esc(s.worstSlot.label)}</b>, ${pct(s.worstSlot.before)} → ${pct(s.worstSlot.during)} (${signed(Math.round(s.worstSlot.change * 100))} points).</p>` : ''}
${s.notes.length ? `<p style="margin:10px 0 0;font-size:13px;color:#333">Notes this week: ${s.notes.map((n) => `${istDate(n.at)} — ${esc(n.text)}`).join('; ')}</p>` : ''}
${link(s)}
</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OMR corridor report · week ${esc(week.key)}</title></head>
<body style="margin:0;padding:20px;background:#fff;color:#111;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:720px;margin:0 auto">
<h1 style="font-size:20px;margin:0 0 2px">Corridor report · week ${esc(week.key)}</h1>
<p style="margin:0 0 20px;color:#777">${esc(week.label)} (Monday to Sunday, IST) · generated ${esc(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC</p>
${summaries.map(section).join('')}
<p style="color:#777;font-size:12px;margin-top:24px">Speed ratio is live speed ÷ free-flow speed averaged over the corridor's sample points; 100% is an empty road. Travel time is corridor length ÷ mean sampled speed. Baseline is every reading recorded before this week at the same time of day. Change is in percentage points. Traffic flow data © TomTom. A comparison tool, not an official travel-time measurement.</p>
</div></body></html>`;
}

/** Plain-text twin for the email's text part. */
export function renderWeeklyText({ summaries, week, baseUrl = '' }) {
  return [
    `Corridor report, week ${week.key} (${week.label}, IST)`,
    '',
    ...summaries.flatMap((s) => [
      headline(s),
      ...s.periods.map((p) => `  ${p.label} ${p.hours}: ${pct(p.speedRatio)} this week vs ${pct(p.baselineRatio)} baseline (${signed(p.changePoints)}), travel ${mins(p.travelTimeS)} vs ${mins(p.baselineTravelTimeS)}`),
      baseUrl ? `  Live report: ${baseUrl}/corridors/${s.corridor.id}/report?hours=168` : '',
      '',
    ]),
    'Speed ratio = live speed / free-flow speed over the corridor sample points. Traffic flow data (c) TomTom.',
  ].join('\n');
}
