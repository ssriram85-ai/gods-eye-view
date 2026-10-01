/**
 * Forecasts with a track record: the expected drive on each road for the
 * next two hours, with a range, issued every sampling round, stored, and
 * scored against what actually happened.
 *
 * Method: the road's typical drive for the target half-hour (median of the
 * same weekday/weekend slot), adjusted by how unusual the road is right now
 * (its last readings against their own typical), with that adjustment
 * fading over the horizon: forecast = typical(target) × (1 + a·e^(−h/τ)).
 * The range is the slot's "most days" range, shifted the same way.
 *
 * Scoring keeps the method honest: each forecast is compared with the real
 * reading at its target time, and so are two simple rivals, "nothing
 * changes" (the current drive) and "a normal day" (the typical drive
 * alone). Published skill is the error of each, by horizon.
 */
import { istSlot, dayType } from './insights.mjs';

export const HORIZONS = Object.freeze([15, 30, 60, 90, 120]);
export const TAU_MIN = 60;

/** How unusual the road is now: mean ratio of the last readings to their typical, minus one. */
export function anomalyNow(recent, profile) {
  const ratios = [];
  for (const s of recent) {
    const slot = (profile?.[dayType(s.ts)] || []).find((p) => p.slot === istSlot(s.ts) && p.days >= 1);
    if (slot?.minutes) ratios.push(s.minutes / slot.minutes);
  }
  if (!ratios.length) return null;
  const a = ratios.reduce((x, y) => x + y, 0) / ratios.length - 1;
  return Math.max(-0.5, Math.min(1.5, a));
}

/** Forecasts for one road from `nowMs`. `recent` = last whole-road readings [{ts, minutes}], newest last. */
export function forecastRoad({ profile, recent, nowMs, tau = TAU_MIN }) {
  if (!recent.length) return [];
  const a = anomalyNow(recent.slice(-3), profile);
  const current = recent[recent.length - 1].minutes;
  return HORIZONS.map((h) => {
    const target = new Date(nowMs + h * 60_000).toISOString();
    const slot = (profile?.[dayType(target)] || []).find((p) => p.slot === istSlot(target) && p.days >= 1);
    if (!slot) return { horizon: h, target, minutes: null };
    const k = a == null ? 1 : 1 + a * Math.exp(-h / tau);
    return { horizon: h, target, minutes: slot.minutes * k, low: (slot.p10 ?? slot.minutes) * k, high: (slot.p90 ?? slot.minutes) * k, typical: slot.minutes, persistence: current };
  }).filter((f) => f.minutes != null);
}

export function createForecastStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forecasts (
      corridor_id TEXT NOT NULL, issued_at TEXT NOT NULL, horizon INTEGER NOT NULL, target_ts TEXT NOT NULL,
      minutes REAL, low REAL, high REAL, typical REAL, persistence REAL, actual REAL,
      PRIMARY KEY (corridor_id, issued_at, horizon)
    );
    CREATE INDEX IF NOT EXISTS idx_forecasts_target ON forecasts (target_ts);
  `);
  const insert = db.prepare('INSERT OR REPLACE INTO forecasts (corridor_id, issued_at, horizon, target_ts, minutes, low, high, typical, persistence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  return {
    issue(corridorId, issuedAt, list) {
      for (const f of list) insert.run(corridorId, issuedAt, f.horizon, f.target, f.minutes, f.low, f.high, f.typical, f.persistence);
      return list.length;
    },
    /** Fill in the real drive for forecasts whose target has a reading within 8 minutes. */
    score(corridorId, totals) {
      const due = db.prepare('SELECT issued_at, horizon, target_ts FROM forecasts WHERE corridor_id = ? AND actual IS NULL AND target_ts <= ?').all(corridorId, new Date().toISOString());
      const upd = db.prepare('UPDATE forecasts SET actual = ? WHERE corridor_id = ? AND issued_at = ? AND horizon = ?');
      let n = 0;
      for (const f of due) {
        const t = Date.parse(f.target_ts);
        let best = null;
        for (const r of totals) {
          const d = Math.abs(Date.parse(r.ts) - t);
          if (d <= 8 * 60_000 && (!best || d < best.d)) best = { d, minutes: r.minutes };
        }
        if (best) upd.run(best.minutes, corridorId, f.issued_at, f.horizon), n++;
      }
      return n;
    },
    latest(corridorId) {
      const at = db.prepare('SELECT MAX(issued_at) AS at FROM forecasts WHERE corridor_id = ?').get(corridorId)?.at;
      return at ? { issuedAt: at, list: db.prepare('SELECT * FROM forecasts WHERE corridor_id = ? AND issued_at = ? ORDER BY horizon').all(corridorId, at) } : null;
    },
    /** Track record by horizon since an instant: typical % error of the forecast and of the two rivals, and range coverage. */
    skill(corridorId, fromIso) {
      const rows = db.prepare('SELECT horizon, minutes, low, high, typical, persistence, actual FROM forecasts WHERE corridor_id = ? AND actual IS NOT NULL AND issued_at >= ?').all(corridorId, fromIso);
      const med = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
      return HORIZONS.map((h) => {
        const r = rows.filter((x) => x.horizon === h);
        if (!r.length) return { horizon: h, n: 0 };
        const err = (pred) => r.map((x) => (pred(x) == null ? null : Math.abs(pred(x) - x.actual) / x.actual));
        return {
          horizon: h,
          n: r.length,
          forecastError: med(err((x) => x.minutes)),
          noChangeError: med(err((x) => x.persistence)),
          normalDayError: med(err((x) => x.typical)),
          coverage: r.filter((x) => x.low != null && x.actual >= x.low && x.actual <= x.high).length / r.length,
        };
      });
    },
    prune: (beforeIso) => db.prepare('DELETE FROM forecasts WHERE issued_at < ?').run(beforeIso).changes,
  };
}

const p = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** One sentence on the track record at one horizon (60 minutes by default). */
export function skillText(skill, horizon = 60) {
  const s = (skill || []).find((x) => x.horizon === horizon);
  if (!s?.n) return 'no forecast has reached its target time yet';
  const beats = s.forecastError != null && s.noChangeError != null && s.normalDayError != null && s.forecastError <= Math.min(s.noChangeError, s.normalDayError);
  return `${horizon} min ahead, over ${s.n} forecasts: typical error ${p(s.forecastError)} (assuming no change: ${p(s.noChangeError)}; assuming a normal day: ${p(s.normalDayError)})${beats ? ', better than both' : ''}; the real drive fell inside the forecast range ${p(s.coverage)} of the time`;
}
