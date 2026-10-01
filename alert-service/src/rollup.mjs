/**
 * Daily roll-up of section travel times: one row per corridor, IST day and
 * 30-minute departure slot, with the median, the 10th and 90th percentile,
 * TomTom's typical and no-traffic times, the share of live observation and
 * the rain that hour. It is what the export publishes, and it is what
 * survives if raw samples are deleted after RAW_RETENTION_DAYS (TomTom's
 * terms limit how long downloaded traffic content may be kept).
 */
import { samplesOf, istSlot, dayKey, quantile, isObserved, SLOT_MIN } from './insights.mjs';
import { rainAt } from './weather.mjs';

const IST_MS = 330 * 60_000;
const DAY = 86_400_000;

/** UTC bounds of an IST calendar day "YYYY-MM-DD". */
export function istDayBounds(day) {
  const start = Date.parse(`${day}T00:00:00+05:30`);
  return { start: new Date(start).toISOString(), end: new Date(start + DAY).toISOString() };
}

export function createRollupStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_slot_daily (
      corridor_id TEXT NOT NULL, day TEXT NOT NULL, slot INTEGER NOT NULL,
      samples INTEGER NOT NULL, median_min REAL, p10_min REAL, p90_min REAL,
      tomtom_usual_min REAL, tomtom_free_min REAL, observed_share REAL, rain_mm REAL,
      section_median_min TEXT,
      PRIMARY KEY (corridor_id, day, slot)
    );
  `);
  const upsert = db.prepare(`INSERT INTO route_slot_daily
      (corridor_id, day, slot, samples, median_min, p10_min, p90_min, tomtom_usual_min, tomtom_free_min, observed_share, rain_mm, section_median_min)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(corridor_id, day, slot) DO UPDATE SET samples = excluded.samples, median_min = excluded.median_min, p10_min = excluded.p10_min,
      p90_min = excluded.p90_min, tomtom_usual_min = excluded.tomtom_usual_min, tomtom_free_min = excluded.tomtom_free_min,
      observed_share = excluded.observed_share, rain_mm = excluded.rain_mm, section_median_min = excluded.section_median_min`);

  /** Roll one IST day up for one corridor from raw rows. Returns the number of slots written. */
  function rollDay({ corridor, day, travel, rain }) {
    const { start, end } = istDayBounds(day);
    const sections = corridor.definition?.sections?.length || 0;
    const samples = samplesOf(travel.rows(corridor.id, start, end), sections);
    const bins = new Map();
    for (const s of samples) {
      const slot = istSlot(s.ts, SLOT_MIN);
      const b = bins.get(slot) || [];
      b.push(s);
      bins.set(slot, b);
    }
    for (const [slot, list] of bins) {
      const totals = list.map((s) => s.travel / 60).sort((a, b) => a - b);
      const legs = Array.from({ length: sections }, (_, i) => quantile(list.map((s) => (s.legs[i] || 0) / 60).sort((a, b) => a - b), 0.5));
      const mm = rain ? list.map((s) => rainAt(rain, s.ts)).filter((x) => x != null) : [];
      upsert.run(
        corridor.id, day, slot, list.length,
        quantile(totals, 0.5), quantile(totals, 0.1), quantile(totals, 0.9),
        quantile(list.map((s) => s.usual / 60).sort((a, b) => a - b), 0.5),
        quantile(list.map((s) => s.free / 60).sort((a, b) => a - b), 0.5),
        list.filter((s) => isObserved(s.travel, s.usual)).length / list.length,
        mm.length ? Math.max(...mm) : null,
        JSON.stringify(legs.map((x) => (x == null ? null : Number(x.toFixed(2))))),
      );
    }
    return bins.size;
  }

  return {
    rollDay,
    /** Days already rolled up for a corridor. */
    days: (corridorId) => db.prepare('SELECT DISTINCT day FROM route_slot_daily WHERE corridor_id = ? ORDER BY day').all(corridorId).map((r) => r.day),
    rows: (fromDay, toDay, corridorId = null) =>
      corridorId
        ? db.prepare('SELECT * FROM route_slot_daily WHERE corridor_id = ? AND day >= ? AND day <= ? ORDER BY corridor_id, day, slot').all(corridorId, fromDay, toDay)
        : db.prepare('SELECT * FROM route_slot_daily WHERE day >= ? AND day <= ? ORDER BY corridor_id, day, slot').all(fromDay, toDay),
    /** Delete raw samples and jam sections older than `days`, but only for days already rolled up. */
    purgeRaw(days, corridorIds) {
      if (!(days > 0)) return { deleted: 0 };
      const cutoffDay = new Date(Date.now() + IST_MS - days * DAY).toISOString().slice(0, 10);
      let deleted = 0;
      for (const id of corridorIds) {
        const rolled = new Set(this.days(id));
        for (const day of rolled) {
          if (day >= cutoffDay) continue;
          const { start, end } = istDayBounds(day);
          deleted += db.prepare('DELETE FROM route_samples WHERE corridor_id = ? AND ts >= ? AND ts < ?').run(id, start, end).changes;
          db.prepare('DELETE FROM route_jams WHERE corridor_id = ? AND ts >= ? AND ts < ?').run(id, start, end);
        }
      }
      return { deleted, cutoffDay };
    },
  };
}

/** Every IST day from the first raw sample up to yesterday that is not rolled up yet (plus yesterday, always). */
export function daysToRoll({ firstTs, rolled, now = Date.now() }) {
  if (!firstTs) return [];
  const today = new Date(now + IST_MS).toISOString().slice(0, 10);
  const out = [];
  for (let d = dayKey(firstTs); d < today; d = new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10)) {
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
    if (!rolled.has(d) || d === yesterday) out.push(d);
  }
  return out;
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(Number(v.toFixed(2))) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The export: one line per corridor, IST day and departure slot. */
export function rollupCsv(rows, corridorsById) {
  const header = ['corridor_id', 'corridor', 'length_km', 'day_ist', 'weekday', 'departure_slot_ist', 'samples', 'median_min', 'p10_min', 'p90_min', 'tomtom_typical_min', 'tomtom_no_traffic_min', 'live_observed_share', 'rain_mm_max_hour', 'section_median_min'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const c = corridorsById.get(r.corridor_id);
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${r.day}T00:00:00Z`).getUTCDay()];
    const slot = `${String(Math.floor(r.slot / 60)).padStart(2, '0')}:${String(r.slot % 60).padStart(2, '0')}`;
    lines.push([r.corridor_id, c?.name, c?.lengthKm, r.day, dow, slot, r.samples, r.median_min, r.p10_min, r.p90_min, r.tomtom_usual_min, r.tomtom_free_min, r.observed_share, r.rain_mm, r.section_median_min].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
