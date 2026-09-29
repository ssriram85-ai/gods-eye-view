/**
 * Turn section travel times into things a commuter or a traffic officer
 * can act on: when a road is at its worst, when to leave instead, which
 * stretch causes the delay, and how today compares with a normal day.
 * Everything is computed from recorded samples; nothing calls TomTom.
 */
const IST_MS = 330 * 60_000;
export const SLOT_MIN = 30;

const pad = (n) => String(n).padStart(2, '0');
export const slotLabel = (slot) => `${pad(Math.floor(slot / 60))}:${pad(slot % 60)}`;
const localDate = (ts) => new Date(Date.parse(ts) + IST_MS);
export const istSlot = (ts, slotMin = SLOT_MIN) => {
  const d = localDate(ts);
  return Math.floor((d.getUTCHours() * 60 + d.getUTCMinutes()) / slotMin) * slotMin;
};
export const dayType = (ts) => {
  const dow = localDate(ts).getUTCDay();
  return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
};
const dayKey = (ts) => localDate(ts).toISOString().slice(0, 10);

/**
 * Typical travel time by departure slot, split weekday / weekend.
 * `rows` are route_samples rows (one per section per sample).
 * Returns { weekday: [slot...], weekend: [slot...] } where each slot has
 * the mean minutes for the whole corridor and per section, and how many
 * distinct days it rests on.
 */
export function travelProfile(rows, { sections = 0, slotMin = SLOT_MIN } = {}) {
  const samples = new Map(); // ts -> {legs: [], ...}
  for (const r of rows) {
    if (r.travel_s == null) continue;
    const s = samples.get(r.ts) || { ts: r.ts, travel: 0, free: 0, usual: 0, legs: [], legFree: [], n: 0 };
    s.travel += r.travel_s;
    s.free += r.no_traffic_s || 0;
    s.usual += r.historic_s || 0;
    s.legs[r.leg] = r.travel_s;
    s.legFree[r.leg] = r.no_traffic_s || 0;
    s.n++;
    samples.set(r.ts, s);
  }
  const bins = { weekday: new Map(), weekend: new Map() };
  for (const s of samples.values()) {
    if (sections && s.n !== sections) continue; // a partial sample would understate the drive
    const type = dayType(s.ts), slot = istSlot(s.ts, slotMin);
    const b = bins[type].get(slot) || { slot, label: slotLabel(slot), n: 0, days: new Set(), travel: 0, free: 0, usual: 0, legs: [], legFree: [] };
    b.n++;
    b.days.add(dayKey(s.ts));
    b.travel += s.travel;
    b.free += s.free;
    b.usual += s.usual;
    s.legs.forEach((v, i) => (b.legs[i] = (b.legs[i] || 0) + (v || 0)));
    s.legFree.forEach((v, i) => (b.legFree[i] = (b.legFree[i] || 0) + (v || 0)));
    bins[type].set(slot, b);
  }
  const finish = (map) =>
    [...map.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((b) => ({
        slot: b.slot,
        label: b.label,
        samples: b.n,
        days: b.days.size,
        minutes: b.travel / b.n / 60,
        freeMinutes: b.free / b.n / 60,
        tomtomUsualMinutes: b.usual / b.n / 60,
        sectionMinutes: b.legs.map((v) => v / b.n / 60),
        sectionFreeMinutes: b.legFree.map((v) => v / b.n / 60),
      }));
  return { weekday: finish(bins.weekday), weekend: finish(bins.weekend) };
}

const WINDOWS = [
  { id: 'morning', label: 'morning', from: 7 * 60, to: 11 * 60 },
  { id: 'evening', label: 'evening', from: 16 * 60, to: 21 * 60 + 30 },
];
const round = (m) => Math.round(m);

/**
 * Plain-language tips for one corridor from its weekday profile.
 * `minDays` guards against advice resting on a single day.
 */
export function commuterTips(corridor, profile, { minDays = 2, minSavingMin = 4 } = {}) {
  const sections = corridor.definition?.sections || [];
  const tips = [];
  const slots = profile.weekday.filter((s) => s.days >= minDays);
  if (slots.length < 6) return { tips, enoughData: false, daysRecorded: Math.max(0, ...profile.weekday.map((s) => s.days)) };
  const worst = slots.reduce((w, s) => (s.minutes > w.minutes ? s : w));
  const free = slots.reduce((a, s) => a + s.freeMinutes, 0) / slots.length;
  tips.push({
    kind: 'peak',
    text: `Worst weekday time: leaving at ${worst.label} takes about ${round(worst.minutes)} min, against ${round(free)} min on an empty road.`,
    slot: worst.label,
    minutes: worst.minutes,
    freeMinutes: free,
  });
  for (const w of WINDOWS) {
    const inWindow = slots.filter((s) => s.slot >= w.from && s.slot < w.to);
    if (inWindow.length < 3) continue;
    const hi = inWindow.reduce((a, s) => (s.minutes > a.minutes ? s : a));
    const lo = inWindow.reduce((a, s) => (s.minutes < a.minutes ? s : a));
    const saving = hi.minutes - lo.minutes;
    if (saving >= minSavingMin)
      tips.push({
        kind: 'depart',
        window: w.id,
        text: `In the ${w.label}, leaving at ${lo.label} instead of ${hi.label} saves about ${round(saving)} min (${round(lo.minutes)} vs ${round(hi.minutes)} min).`,
        best: lo.label,
        worst: hi.label,
        savingMinutes: saving,
      });
  }
  // Which stretch carries the delay at the worst time.
  const excess = worst.sectionMinutes.map((m, i) => ({ i, extra: m - (worst.sectionFreeMinutes[i] || 0), minutes: m }));
  const top = excess.sort((a, b) => b.extra - a.extra)[0];
  const totalExtra = worst.minutes - worst.freeMinutes;
  if (top && sections[top.i] && top.extra >= 2 && totalExtra > 0)
    tips.push({
      kind: 'bottleneck',
      text: `At ${worst.label} the slowest stretch is ${sections[top.i].from} → ${sections[top.i].to}: ${round(top.minutes)} min for ${sections[top.i].lengthKm} km, ${round(top.extra)} of the ${round(totalExtra)} extra minutes on the whole road.`,
      section: `${sections[top.i].from} → ${sections[top.i].to}`,
      extraMinutes: top.extra,
      shareOfDelay: top.extra / totalExtra,
    });
  const weekend = profile.weekend.filter((s) => s.days >= 1);
  if (weekend.length >= 6) {
    const wkWorst = weekend.reduce((w, s) => (s.minutes > w.minutes ? s : w));
    if (worst.minutes - wkWorst.minutes >= minSavingMin)
      tips.push({ kind: 'weekend', text: `Weekends peak lower: the worst weekend time (${wkWorst.label}) takes ${round(wkWorst.minutes)} min, ${round(worst.minutes - wkWorst.minutes)} less than the weekday peak.` });
  }
  return { tips, enoughData: true, daysRecorded: Math.max(...slots.map((s) => s.days)) };
}

/** How the latest sample compares with a normal day at this time. */
export function liveStatus(corridor, latest, profile) {
  if (!latest?.ts || !latest.rows?.length) return null;
  const minutes = latest.rows.reduce((a, r) => a + (r.travel_s || 0), 0) / 60;
  const free = latest.rows.reduce((a, r) => a + (r.no_traffic_s || 0), 0) / 60;
  const tomtomUsual = latest.rows.reduce((a, r) => a + (r.historic_s || 0), 0) / 60;
  const slot = istSlot(latest.ts);
  const own = (profile?.[dayType(latest.ts)] || []).find((s) => s.slot === slot && s.days >= 2);
  const usual = own ? own.minutes : tomtomUsual || null;
  const ratio = free ? minutes / free : null;
  const level = ratio == null ? 'unknown' : ratio < 1.2 ? 'clear' : ratio < 1.5 ? 'busy' : ratio < 2 ? 'heavy' : 'jammed';
  const sections = corridor.definition?.sections || [];
  const worst = latest.rows
    .map((r) => ({ r, extra: (r.travel_s || 0) - (r.no_traffic_s || 0) }))
    .sort((a, b) => b.extra - a.extra)[0];
  return {
    ts: latest.ts,
    minutes,
    freeMinutes: free,
    usualMinutes: usual,
    usualSource: own ? 'recorded' : 'tomtom',
    vsUsual: usual ? minutes - usual : null,
    level,
    slowest: worst && sections[worst.r.leg] ? { section: `${sections[worst.r.leg].from} → ${sections[worst.r.leg].to}`, minutes: worst.r.travel_s / 60, extraMinutes: worst.extra / 60 } : null,
    jams: (latest.jams || []).filter((j) => j.category === 'jam').length,
    detour: latest.rows.some((r) => r.detour),
  };
}
