/**
 * Impact evaluation: did a change on a road (a closed U-turn, a new signal
 * plan, a diversion) make its drive faster or slower?
 *
 * Method: difference-in-differences against the untouched roads. For each
 * reading, take the log of the changed road's drive minus the mean log of
 * the control roads' drives at the same moment. Citywide effects (rain, a
 * holiday, school traffic) move every road and cancel out. Compare that
 * difference before and after the change, slot by slot (same weekday or
 * weekend, same half hour), and turn it into a percentage. Uncertainty
 * comes from resampling whole days (a bad day stays one bad day). A
 * placebo check runs the same test on each control road as if it had been
 * changed: if untouched roads often show "effects" this big, the result is
 * not trusted.
 */
import { istSlot, dayType, dayKey, quantile } from './insights.mjs';

const DAY = 86_400_000;
export const MIN = Object.freeze({ preDays: 5, postDays: 1, slots: 6 });

/** Whole-corridor totals keyed by 15-minute bucket, full readings only. */
export function totalsByBucket(travel, corridor, fromIso, toIso) {
  const n = corridor.definition?.sections?.length || 0;
  const out = new Map();
  for (const r of travel.totals(corridor.id, fromIso, toIso)) {
    if (r.travel_s == null || (n && r.legs !== n)) continue;
    const key = new Date(Math.round(Date.parse(r.ts) / 900_000) * 900_000).toISOString();
    out.set(key, r.travel_s / 60);
  }
  return out;
}

/** Per-reading log difference between the changed road and the mean of the controls. */
export function differences(treated, controls) {
  const rows = [];
  for (const [ts, t] of treated) {
    const cs = controls.map((m) => m.get(ts)).filter((x) => x > 0);
    if (!(t > 0) || cs.length < Math.max(1, Math.ceil(controls.length / 2))) continue;
    const meanLogC = cs.reduce((a, x) => a + Math.log(x), 0) / cs.length;
    rows.push({ ts, d: Math.log(t) - meanLogC, minutes: t, slot: `${dayType(ts)}:${istSlot(ts)}`, day: dayKey(ts) });
  }
  return rows;
}

/** DiD over slots present in both windows, weighted by the after-window's readings per slot. */
export function didEstimate(pre, post) {
  const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const bySlot = (rows) => {
    const m = new Map();
    for (const r of rows) (m.get(r.slot) || m.set(r.slot, []).get(r.slot)).push(r.d);
    return m;
  };
  const a = bySlot(pre), b = bySlot(post);
  let num = 0, den = 0, slots = 0;
  for (const [slot, ds] of b) {
    if (!a.has(slot)) continue;
    num += (mean(ds) - mean(a.get(slot))) * ds.length;
    den += ds.length;
    slots++;
  }
  return den ? { did: num / den, slots } : { did: null, slots: 0 };
}

/** Deterministic pseudo-random numbers so a result can be reproduced exactly. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296);
}

/** Bootstrap by day (or by reading if a window has a single day). */
function bootstrap(pre, post, reps, seed) {
  const r = rng(seed);
  const group = (rows) => {
    const days = new Map();
    for (const x of rows) (days.get(x.day) || days.set(x.day, []).get(x.day)).push(x);
    return [...days.values()];
  };
  const preDays = group(pre), postDays = group(post);
  const draw = (groups, flat) => {
    if (groups.length >= 2) {
      const out = [];
      for (let i = 0; i < groups.length; i++) out.push(...groups[Math.floor(r() * groups.length)]);
      return out;
    }
    return flat.map(() => flat[Math.floor(r() * flat.length)]);
  };
  const out = [];
  for (let i = 0; i < reps; i++) {
    const e = didEstimate(draw(preDays, pre), draw(postDays, post));
    if (e.did != null) out.push(e.did);
  }
  return out.sort((x, y) => x - y);
}

/**
 * Evaluate one change. `treated` and each of `controls` are corridors;
 * `start`/`end` are ISO instants (end defaults to now). Optional
 * `hours` = [fromMin, toMin) restricts both windows to those IST minutes
 * (e.g. a change that applies only at peak hours).
 */
export function evaluateChange({ travel, treated, controls, start, end = null, preDays = 14, hours = null, reps = 600, seed = 7, now = Date.now(), placebo = true }) {
  const startMs = Date.parse(start);
  const endMs = Math.min(end ? Date.parse(end) : now, now);
  const fromIso = new Date(startMs - preDays * DAY).toISOString();
  const toIso = new Date(endMs).toISOString();
  const inHours = (ts) => !hours || (istSlot(ts, 15) >= hours[0] && istSlot(ts, 15) < hours[1]);
  const series = (c) => totalsByBucket(travel, c, fromIso, toIso);
  const tSeries = series(treated);
  const cSeries = controls.map(series);
  const rows = differences(tSeries, cSeries).filter((r) => inHours(r.ts));
  const pre = rows.filter((r) => Date.parse(r.ts) < startMs);
  const post = rows.filter((r) => Date.parse(r.ts) >= startMs && Date.parse(r.ts) < endMs);
  const preDaysN = new Set(pre.map((r) => r.day)).size, postDaysN = new Set(post.map((r) => r.day)).size;
  const base = { corridor: treated.id, controls: controls.map((c) => c.id), start, end: end || null, window: { preDays: preDaysN, postDays: postDaysN, preReadings: pre.length, postReadings: post.length } };
  const problems = [];
  if (preDaysN < MIN.preDays) problems.push(`only ${preDaysN} day${preDaysN === 1 ? '' : 's'} recorded before the change (needs ${MIN.preDays})`);
  if (postDaysN < MIN.postDays || !post.length) problems.push('no readings since the change');
  const est = didEstimate(pre, post);
  if (!problems.length && est.slots < MIN.slots) problems.push(`only ${est.slots} matching half-hours before and after (needs ${MIN.slots})`);
  if (problems.length || est.did == null) return { ...base, status: 'insufficient', problems };
  const boot = bootstrap(pre, post, reps, seed);
  const lo = quantile(boot, 0.025), hi = quantile(boot, 0.975);
  const pct = (x) => Math.exp(x) - 1;
  const typicalAfter = post.reduce((a, r) => a + r.minutes, 0) / post.length;
  const effect = pct(est.did);
  const result = {
    ...base,
    status: lo > 0 || hi < 0 ? 'significant' : 'not-significant',
    effectPct: effect,
    ciPct: [pct(lo), pct(hi)],
    effectMinutes: typicalAfter - typicalAfter / (1 + effect),
    slots: est.slots,
    singleDay: postDaysN < 2 || preDaysN < 2,
  };
  if (placebo && controls.length >= 2) {
    // Each control as if it had been changed, against the other controls, same windows.
    const fakes = controls.map((c, i) => {
      const others = controls.filter((_, j) => j !== i);
      const r = evaluateChange({ travel, treated: c, controls: others, start, end, preDays, hours, reps: 200, seed: seed + i + 1, now, placebo: false });
      return { corridor: c.id, effectPct: r.effectPct ?? null, significant: r.status === 'significant' };
    }).filter((f) => f.effectPct != null);
    result.placebo = {
      runs: fakes.length,
      significant: fakes.filter((f) => f.significant).length,
      asLarge: fakes.filter((f) => Math.abs(f.effectPct) >= Math.abs(effect)).length,
    };
    if (result.status === 'significant' && fakes.length && result.placebo.asLarge / fakes.length > 0.2) result.status = 'not-significant', (result.caution = 'untouched roads moved as much in the same period');
  }
  return result;
}

const sgn = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;

/** One plain sentence for an evaluation. */
export function impactText(r, names = {}) {
  const name = names[r.corridor] || r.corridor;
  if (r.status === 'insufficient') return `${name}: cannot be evaluated yet: ${r.problems.join('; ')}.`;
  const range = `${sgn(r.ciPct[0])} to ${sgn(r.ciPct[1])}`;
  const mins = Math.abs(r.effectMinutes) >= 0.5 ? ` (about ${Math.abs(Math.round(r.effectMinutes))} min ${r.effectMinutes > 0 ? 'longer' : 'shorter'} per drive)` : '';
  const verdict = r.status === 'significant' ? `${r.effectPct > 0 ? 'slower' : 'faster'}: ${sgn(r.effectPct)}${mins}, 95% range ${range}` : `no clear change: ${sgn(r.effectPct)}, 95% range ${range} includes zero`;
  const placebo = r.placebo?.runs ? ` Placebo check: ${r.placebo.asLarge} of ${r.placebo.runs} untouched roads moved as much.` : '';
  const caution = r.caution ? ` Not counted as a finding: ${r.caution}.` : '';
  const thin = r.singleDay ? ' Based on a single day on one side, so treat it as indicative.' : '';
  return `${name}, relative to the other monitored roads: ${verdict}. ${r.window.preDays} day${r.window.preDays === 1 ? '' : 's'} before, ${r.window.postDays} after.${placebo}${caution}${thin}`;
}

export function createInterventionStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS interventions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, corridors TEXT NOT NULL, start_ts TEXT NOT NULL, end_ts TEXT,
      hours TEXT, source TEXT, created_at TEXT NOT NULL
    );
  `);
  return {
    upsert({ id, title, corridors, start, end = null, hours = null, source = null }) {
      db.prepare(`INSERT INTO interventions (id, title, corridors, start_ts, end_ts, hours, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, corridors = excluded.corridors, start_ts = excluded.start_ts, end_ts = excluded.end_ts, hours = excluded.hours, source = excluded.source`)
        .run(id, String(title).slice(0, 200), JSON.stringify(corridors), start, end, hours ? JSON.stringify(hours) : null, source, new Date().toISOString());
    },
    list: () => db.prepare('SELECT * FROM interventions ORDER BY start_ts DESC').all().map((r) => ({ ...r, corridors: JSON.parse(r.corridors), hours: r.hours ? JSON.parse(r.hours) : null })),
  };
}

/** Controls for a change: every other monitored road not on the same road (both directions of a changed road are treated). */
export function controlsFor(treated, all) {
  return all.filter((c) => c.id !== treated.id && c.definition?.road !== treated.definition?.road);
}
