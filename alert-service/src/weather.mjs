/**
 * Hourly rainfall along each monitored road (Open-Meteo, no key), so a
 * slow evening can be told apart from a wet one. Recorded every hour with
 * a few days of look-back, so a missed poll heals itself.
 */
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

/** One rain point per road, roughly mid-corridor. */
export const RAIN_POINTS = Object.freeze({
  omr: { lat: 12.93, lon: 80.232 },
  'anna-salai': { lat: 13.035, lon: 80.243 },
  gst: { lat: 12.955, lon: 80.143 },
  ecr: { lat: 12.925, lon: 80.252 },
});

/** Rain intensity bands (mm in an hour), IMD-style wording. */
export const rainBand = (mm) => (mm == null ? null : mm >= 15 ? 'heavy' : mm >= 7.5 ? 'moderate' : mm >= 2.5 ? 'light' : mm > 0.2 ? 'drizzle' : 'dry');

export async function fetchRain({ points = RAIN_POINTS, pastDays = 3, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const names = Object.keys(points);
  const params = new URLSearchParams({
    latitude: names.map((n) => points[n].lat).join(','),
    longitude: names.map((n) => points[n].lon).join(','),
    hourly: 'precipitation',
    past_days: String(pastDays),
    forecast_days: '1',
    timezone: 'UTC',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${FORECAST}?${params}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const body = await r.json();
    const list = Array.isArray(body) ? body : [body];
    const now = Date.now();
    const rows = [];
    list.forEach((loc, i) => {
      const t = loc?.hourly?.time || [], p = loc?.hourly?.precipitation || [];
      t.forEach((hour, k) => {
        const iso = new Date(`${hour}Z`).toISOString();
        if (Date.parse(iso) > now) return; // only hours that have happened
        if (Number.isFinite(p[k])) rows.push({ point: names[i], hour: iso, mm: p[k] });
      });
    });
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

export function createWeatherStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rain_hourly (
      point TEXT NOT NULL, hour TEXT NOT NULL, mm REAL, PRIMARY KEY (point, hour)
    );
  `);
  const upsert = db.prepare('INSERT INTO rain_hourly (point, hour, mm) VALUES (?, ?, ?) ON CONFLICT(point, hour) DO UPDATE SET mm = excluded.mm');
  return {
    record(rows) {
      for (const r of rows) upsert.run(r.point, r.hour, r.mm);
      return rows.length;
    },
    /** Map of hour ISO → mm for one point between two instants. */
    series(point, fromIso, toIso) {
      const out = new Map();
      for (const r of db.prepare('SELECT hour, mm FROM rain_hourly WHERE point = ? AND hour >= ? AND hour < ? ORDER BY hour').all(point, fromIso, toIso)) out.set(r.hour, r.mm);
      return out;
    },
    total: (point, fromIso, toIso) => db.prepare('SELECT COALESCE(SUM(mm), 0) AS mm, COUNT(*) AS hours, SUM(CASE WHEN mm >= 2.5 THEN 1 ELSE 0 END) AS wet FROM rain_hourly WHERE point = ? AND hour >= ? AND hour < ?').get(point, fromIso, toIso),
  };
}

/** The rain in the hour containing `ts` (an ISO instant), or null if unknown. */
export function rainAt(series, ts) {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return series.has(d.toISOString()) ? series.get(d.toISOString()) : null;
}
