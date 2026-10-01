/**
 * Turn section travel times into findings that hold up in front of a
 * traffic official: when each road's rush builds, peaks and eases, how
 * long the drive takes on a normal day and on a bad one, whether moving a
 * departure by up to an hour genuinely helps, which stretch carries the
 * delay, and how much of it rests on live observation rather than TomTom's
 * historical model. Everything comes from recorded samples; nothing calls
 * TomTom.
 *
 * Rules that keep findings honest:
 *  - The reference is our own night-time drive, not TomTom's "no traffic"
 *    time (which is slower than real night drives in Chennai).
 *  - Typical figures are medians; "most days" ranges are the 10th–90th
 *    percentiles of the same departure slot.
 *  - The rush is found over the whole day, never inside fixed windows, so
 *    a window edge can never become the "best time to leave".
 *  - A departure shift is advised only if it saves SHIFT_MIN_SAVING minutes
 *    within an hour of the peak.
 *  - A stretch is named as the bottleneck only if it carries at least a
 *    third of the extra time and at least 1.5 times the next stretch's.
 *  - Every finding carries how many weekdays it rests on.
 */
const IST_MS = 330 * 60_000;
export const SLOT_MIN = 30;
export const SHIFT_MIN_SAVING = 6;
export const OBSERVED_SHARE_MIN = 0.15;
export const CONFIDENCE = Object.freeze({ provisional: 5, established: 10 });

const pad = (n) => String(n).padStart(2, '0');
export const slotLabel = (slot) => `${pad(Math.floor(slot / 60) % 24)}:${pad(slot % 60)}`;
const localDate = (ts) => new Date(Date.parse(ts) + IST_MS);
export const istSlot = (ts, slotMin = SLOT_MIN) => {
  const d = localDate(ts);
  return Math.floor((d.getUTCHours() * 60 + d.getUTCMinutes()) / slotMin) * slotMin;
};
export const dayType = (ts) => {
  const dow = localDate(ts).getUTCDay();
  return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
};
export const dayKey = (ts) => localDate(ts).toISOString().slice(0, 10);

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const median = (xs) => quantile([...xs].sort((a, b) => a - b), 0.5);

/** Did a live sample depart from TomTom's historical time enough to count as observed? */
export const isObserved = (travelS, historicS) => historicS != null && Math.abs(travelS - historicS) >= Math.max(120, 0.05 * historicS);

/** Group section rows into whole-corridor samples; partial samples are dropped. */
export function samplesOf(rows, sections) {
  const map = new Map();
  for (const r of rows) {
    if (r.travel_s == null) continue;
    const s = map.get(r.ts) || { ts: r.ts, travel: 0, free: 0, usual: 0, legs: [], n: 0, detour: 0 };
    s.travel += r.travel_s;
    s.free += r.no_traffic_s || 0;
    s.usual += r.historic_s || 0;
    s.legs[r.leg] = r.travel_s;
    s.detour = Math.max(s.detour, r.detour || 0);
    s.n++;
    map.set(r.ts, s);
  }
  return [...map.values()].filter((s) => !sections || s.n === sections).sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Typical travel time by departure slot, split weekday / weekend: median,
 * 10th and 90th percentile minutes, per-section medians, and how many
 * distinct days each slot rests on.
 */
export function travelProfile(rows, { sections = 0, slotMin = SLOT_MIN } = {}) {
  const bins = { weekday: new Map(), weekend: new Map() };
  for (const s of samplesOf(rows, sections)) {
    const slot = istSlot(s.ts, slotMin);
    const b = bins[dayType(s.ts)].get(slot) || { slot, totals: [], free: [], usual: [], legs: [], days: new Set(), observed: 0 };
    b.totals.push(s.travel / 60);
    b.free.push(s.free / 60);
    b.usual.push(s.usual / 60);
    s.legs.forEach((v, i) => (b.legs[i] = b.legs[i] || []).push((v || 0) / 60));
    b.days.add(dayKey(s.ts));
    if (isObserved(s.travel, s.usual)) b.observed++;
    bins[dayType(s.ts)].set(slot, b);
  }
  const finish = (map) =>
    [...map.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((b) => {
        const sorted = [...b.totals].sort((x, y) => x - y);
        return {
          slot: b.slot,
          label: slotLabel(b.slot),
          samples: b.totals.length,
          days: b.days.size,
          minutes: quantile(sorted, 0.5),
          p10: quantile(sorted, 0.1),
          p90: quantile(sorted, 0.9),
          tomtomFreeMinutes: median(b.free),
          tomtomUsualMinutes: median(b.usual),
          sectionMinutes: b.legs.map((xs) => median(xs || [0])),
          observedShare: b.observed / b.totals.length,
        };
      });
  return { weekday: finish(bins.weekday), weekend: finish(bins.weekend) };
}

/** Distinct weekdays and weekend days behind a set of rows. */
export function daysCovered(rows) {
  const wd = new Set(), we = new Set();
  for (const r of rows) (dayType(r.ts) === 'weekday' ? wd : we).add(dayKey(r.ts));
  return { weekdays: wd.size, weekendDays: we.size };
}

export function confidenceOf(weekdays) {
  if (weekdays >= CONFIDENCE.established) return { level: 'established', text: `${weekdays} weekdays recorded` };
  if (weekdays >= CONFIDENCE.provisional) return { level: 'provisional', text: `provisional: ${weekdays} weekdays recorded, established at ${CONFIDENCE.established}` };
  return { level: 'early', text: `early data: ${weekdays} weekday${weekdays === 1 ? '' : 's'} recorded, provisional at ${CONFIDENCE.provisional}` };
}

/** How much of a corridor's record is live observation rather than TomTom's model. */
export function sourceOf(rows, sections) {
  const samples = samplesOf(rows, sections);
  const observed = samples.filter((s) => isObserved(s.travel, s.usual)).length;
  const share = samples.length ? observed / samples.length : 0;
  return {
    share,
    kind: share >= OBSERVED_SHARE_MIN ? 'observed' : 'modelled',
    text:
      share >= OBSERVED_SHARE_MIN
        ? `live observations: in ${Math.round(share * 100)}% of readings the live time differed from TomTom's typical time`
        : `mostly TomTom's typical pattern: live times matched TomTom's history in ${Math.round((1 - share) * 100)}% of readings, so day-to-day changes here are not well observed`,
  };
}

/** Our own reference drive: the quickest typical slot between midnight and 05:30. */
export function nightBaseline(slots) {
  const night = slots.filter((s) => s.slot < 330 && s.days >= 1);
  const pool = night.length ? night : slots;
  if (!pool.length) return null;
  const best = pool.reduce((a, s) => (s.minutes < a.minutes ? s : a));
  return { minutes: best.minutes, slot: best.slot, label: best.label, sectionMinutes: best.sectionMinutes };
}

const PERIODS = [
  { id: 'morning', from: 5 * 60, to: 13 * 60 },
  { id: 'evening', from: 13 * 60, to: 24 * 60 },
];

/**
 * The shape of each rush: where it peaks (searched over a broad half-day),
 * and how far either side the road stays at least 30% of the way from its
 * night-time drive to that peak. Searching the whole day means the edges
 * come from the data, not from a window.
 */
export function rushShapes(slots, baseline) {
  if (!baseline || slots.length < 6) return [];
  const bySlot = new Map(slots.map((s) => [s.slot, s]));
  const out = [];
  for (const p of PERIODS) {
    const inPeriod = slots.filter((s) => s.slot >= p.from && s.slot < p.to);
    if (!inPeriod.length) continue;
    const peak = inPeriod.reduce((a, s) => (s.minutes > a.minutes ? s : a));
    const extra = peak.minutes - baseline.minutes;
    if (extra < 5) {
      out.push({ period: p.id, none: true, peak, extraMinutes: extra });
      continue;
    }
    const threshold = baseline.minutes + 0.3 * extra;
    let start = peak.slot, end = peak.slot;
    for (let t = peak.slot - SLOT_MIN; t >= 0 && bySlot.get(t)?.minutes >= threshold; t -= SLOT_MIN) start = t;
    for (let t = peak.slot + SLOT_MIN; t < 24 * 60 && bySlot.get(t)?.minutes >= threshold; t += SLOT_MIN) end = t;
    out.push({
      period: p.id,
      start,
      startLabel: slotLabel(start),
      peak,
      endLabel: slotLabel(end + SLOT_MIN),
      end: end + SLOT_MIN,
      extraMinutes: extra,
      baselineMinutes: baseline.minutes,
    });
  }
  // A morning that runs straight into the evening is one long busy day.
  const [m, e] = out;
  if (m && e && !m.none && !e.none && m.end >= e.start) for (const r of out) r.continuous = true;
  return out;
}

const r0 = (x) => Math.round(x);
const range = (s) => (s.p10 != null && s.p90 != null && r0(s.p90) > r0(s.p10) ? `${r0(s.p10)}–${r0(s.p90)} on most days` : null);

/**
 * Findings for one corridor from its weekday profile. Each has a `kind`,
 * a `period` where it applies, and plain text. Advice needs at least two
 * days behind every slot it uses.
 */
export function commuterTips(corridor, profile, { minDays = 2 } = {}) {
  const sections = corridor.definition?.sections || [];
  const slots = profile.weekday.filter((s) => s.days >= minDays);
  const daysRecorded = Math.max(0, ...profile.weekday.map((s) => s.days));
  if (slots.length < 12) return { tips: [], rushes: [], baseline: null, enoughData: false, daysRecorded };
  const baseline = nightBaseline(slots);
  const rushes = rushShapes(slots, baseline);
  const tips = [];
  for (const r of rushes) {
    const name = r.period === 'morning' ? 'Morning' : 'Evening';
    if (r.none) {
      tips.push({ kind: 'calm', period: r.period, text: `${name}: no real rush; the worst slot (${r.peak.label}) is within ${Math.max(1, r0(r.extraMinutes))} min of the night-time drive.` });
      continue;
    }
    const rg = range(r.peak);
    tips.push({
      kind: 'rush',
      period: r.period,
      start: r.startLabel,
      peakAt: r.peak.label,
      end: r.endLabel,
      peakMinutes: r.peak.minutes,
      baselineMinutes: baseline.minutes,
      text: `${name} rush: builds from ${r.startLabel}, worst at ${r.peak.label} (about ${r0(r.peak.minutes)} min${rg ? `, ${rg}` : ''}), eases by ${r.endLabel}. The same drive takes ${r0(baseline.minutes)} min at night.`,
    });
    // A realistic change: up to an hour either side of the peak.
    const near = slots.filter((s) => s.slot !== r.peak.slot && Math.abs(s.slot - r.peak.slot) <= 60);
    const best = near.length ? near.reduce((a, s) => (s.minutes < a.minutes ? s : a)) : null;
    const saving = best ? r.peak.minutes - best.minutes : 0;
    if (best && saving >= SHIFT_MIN_SAVING)
      tips.push({ kind: 'shift', period: r.period, from: r.peak.label, to: best.label, savingMinutes: saving, text: `Leaving at ${best.label} instead of ${r.peak.label} saves about ${r0(saving)} min (${r0(best.minutes)} vs ${r0(r.peak.minutes)}).` });
    else
      tips.push({ kind: 'no-shift', period: r.period, savingMinutes: saving, text: `No quick win around ${r.peak.label}: leaving up to an hour earlier or later saves ${saving >= 1 ? `at most ${r0(saving)} min` : 'nothing'}.` });
    // Which stretch carries the extra time at the peak, against its own night-time drive.
    const extra = r.peak.sectionMinutes.map((v, i) => ({ i, extra: v - (baseline.sectionMinutes[i] ?? v), minutes: v }));
    const total = extra.reduce((a, x) => a + Math.max(0, x.extra), 0);
    const [top, second] = [...extra].sort((a, b) => b.extra - a.extra);
    const standsOut = top && (!second || second.extra <= 0 || top.extra >= 1.5 * second.extra);
    if (top && sections[top.i] && total >= 3 && top.extra / total >= 1 / 3 && standsOut)
      tips.push({ kind: 'bottleneck', period: r.period, section: `${sections[top.i].from} → ${sections[top.i].to}`, share: top.extra / total, text: `At ${r.peak.label}, ${sections[top.i].from} → ${sections[top.i].to} carries ${r0((top.extra / total) * 100)}% of the extra time: ${r0(top.minutes)} min for ${sections[top.i].lengthKm} km.` });
    else if (total >= 3) tips.push({ kind: 'spread', period: r.period, text: `At ${r.peak.label} the delay is spread along the road; no single stretch stands out.` });
  }
  if (rushes.length && rushes[0].continuous) tips.push({ kind: 'continuous', text: 'Between the two rushes the road never returns to its night-time pace.' });
  return { tips, rushes, baseline, enoughData: true, daysRecorded };
}

/** Morning advice until noon, evening advice until 21:30, then tomorrow morning's. */
export function nextCommute(ts = new Date().toISOString()) {
  const d = localDate(ts);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return min < 12 * 60 || min >= 21 * 60 + 30 ? 'morning' : 'evening';
}

/** How the latest sample compares with a normal day at this time, and with the night-time drive. */
export function liveStatus(corridor, latest, profile, baseline = null) {
  if (!latest?.ts || !latest.rows?.length) return null;
  const minutes = latest.rows.reduce((a, r) => a + (r.travel_s || 0), 0) / 60;
  const tomtomUsual = latest.rows.reduce((a, r) => a + (r.historic_s || 0), 0) / 60;
  const tomtomFree = latest.rows.reduce((a, r) => a + (r.no_traffic_s || 0), 0) / 60;
  const slot = istSlot(latest.ts);
  const own = (profile?.[dayType(latest.ts)] || []).find((s) => s.slot === slot && s.days >= 2);
  const usual = own ? own.minutes : tomtomUsual || null;
  const night = baseline?.minutes ?? tomtomFree;
  const ratio = night ? minutes / night : null;
  const level = ratio == null ? 'unknown' : ratio < 1.15 ? 'clear' : ratio < 1.4 ? 'busy' : ratio < 1.75 ? 'heavy' : 'jammed';
  const vsUsual = usual ? minutes - usual : null;
  const unusual = vsUsual != null && (vsUsual >= Math.max(5, 0.12 * usual) || (own?.p90 != null && minutes > own.p90 + 3));
  const sections = corridor.definition?.sections || [];
  const worst = latest.rows
    .map((r) => ({ r, extra: (r.travel_s || 0) / 60 - (baseline?.sectionMinutes?.[r.leg] ?? (r.no_traffic_s || 0) / 60) }))
    .sort((a, b) => b.extra - a.extra)[0];
  return {
    ts: latest.ts,
    minutes,
    nightMinutes: night,
    nightSource: baseline ? 'recorded' : 'tomtom',
    usualMinutes: usual,
    usualRange: own && own.p10 != null ? [own.p10, own.p90] : null,
    usualSource: own ? 'recorded' : 'tomtom',
    vsUsual,
    unusual,
    level,
    slowest: worst && sections[worst.r.leg] && worst.extra >= 2 ? { section: `${sections[worst.r.leg].from} → ${sections[worst.r.leg].to}`, minutes: worst.r.travel_s / 60, extraMinutes: worst.extra } : null,
    jams: (latest.jams || []).filter((j) => j.category === 'jam').length,
    closures: (latest.jams || []).filter((j) => j.category === 'closure').length,
    detour: latest.rows.some((r) => r.detour),
  };
}

/**
 * Notes that only make sense across roads: a road whose worst rush is in
 * the morning when most are in the evening, and directions of the same
 * road that peak an hour or more apart.
 */
export function crossRoadNotes(insights) {
  const notes = new Map(insights.map((i) => [i.corridor.id, []]));
  const worstOf = (i) => (i.rushes || []).filter((r) => !r.none).sort((a, b) => b.peak.minutes - a.peak.minutes)[0];
  const worst = insights.map((i) => ({ i, w: worstOf(i) })).filter((x) => x.w);
  const evening = worst.filter((x) => x.w.period === 'evening').length;
  const morning = worst.length - evening;
  for (const { i, w } of worst) {
    const minority = (w.period === 'morning' && morning < evening) || (w.period === 'evening' && evening < morning);
    if (minority && worst.length >= 4)
      notes.get(i.corridor.id).push(`Unlike most monitored roads, its worst rush is in the ${w.period} (${w.peak.label}).`);
  }
  const byRoad = new Map();
  for (const x of worst) {
    const road = x.i.corridor.definition?.road;
    if (!byRoad.has(road)) byRoad.set(road, []);
    byRoad.get(road).push(x);
  }
  for (const pair of byRoad.values()) {
    if (pair.length !== 2) continue;
    for (const period of ['morning', 'evening']) {
      const [a, b] = pair.map((x) => (x.i.rushes || []).find((r) => r.period === period && !r.none));
      if (!a || !b) continue;
      const gap = a.peak.slot - b.peak.slot;
      if (Math.abs(gap) >= 60) {
        const [early, late] = gap < 0 ? [pair[0], pair[1]] : [pair[1], pair[0]];
        const dirOf = (x) => x.i.corridor.definition?.direction || x.i.corridor.name;
        notes.get(early.i.corridor.id).push(`Its ${period} peak comes ${Math.abs(gap) === 60 ? 'an hour' : `${Math.abs(gap) / 60} hours`} before the ${dirOf(late)} direction's.`);
      }
    }
  }
  return notes;
}
