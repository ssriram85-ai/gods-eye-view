/**
 * Corridor monitor: records how a road corridor flows, every few minutes,
 * so a change to it (a closed U-turn, a new signal plan, a diversion) can
 * be judged against how the corridor behaved before, not against complaints.
 *
 * Data: TomTom's Flow Segment Data API, one call per sample point, which
 * returns the live and free-flow speed of the road segment nearest the
 * point. A corridor is defined by two ends (and optional via points); its
 * geometry comes from TomTom routing once, then is resampled to N evenly
 * spaced points along the road. Each direction of a divided road is its
 * own corridor, because routing A→B and B→A lands on different carriageways.
 *
 * Storage: node:sqlite. Samples are keyed by (corridor, time, point).
 */
import { DatabaseSync } from 'node:sqlite';
import { haversineKm } from './geo.mjs';

const ROUTING = 'https://api.tomtom.com/routing/1/calculateRoute';
const FLOW = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json';
export const DEFAULT_POINTS = 12;
const MAX_POINTS = 40;
const CONCURRENCY = 4;

const num = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** Corridors the monitor seeds when the store is empty and a key is present. */
export const SEED_CORRIDORS = Object.freeze([
  {
    id: 'omr-south',
    name: 'OMR southbound · Madhya Kailash → Siruseri',
    from: { lat: 13.0067, lon: 80.254 },
    to: { lat: 12.825, lon: 80.22 },
    points: DEFAULT_POINTS,
  },
  {
    id: 'omr-north',
    name: 'OMR northbound · Siruseri → Madhya Kailash',
    from: { lat: 12.825, lon: 80.22 },
    to: { lat: 13.0067, lon: 80.254 },
    points: DEFAULT_POINTS,
  },
]);

/** Evenly spaced points along a polyline of {lat, lon}, by road distance. */
export function resamplePolyline(path, count) {
  if (!Array.isArray(path) || path.length < 2) throw new Error('route has fewer than two points');
  const cumulative = [0];
  for (let i = 1; i < path.length; i++)
    cumulative.push(cumulative[i - 1] + haversineKm(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon));
  const length = cumulative[cumulative.length - 1];
  if (!(length > 0)) throw new Error('route has no length');
  const points = [];
  for (let k = 0; k < count; k++) {
    const target = (length * (k + 0.5)) / count;
    let i = 1;
    while (i < cumulative.length - 1 && cumulative[i] < target) i++;
    const span = cumulative[i] - cumulative[i - 1] || 1;
    const t = Math.min(1, Math.max(0, (target - cumulative[i - 1]) / span));
    points.push({
      lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t,
      lon: path[i - 1].lon + (path[i].lon - path[i - 1].lon) * t,
      km: Number(target.toFixed(2)),
    });
  }
  return { points, lengthKm: Number(length.toFixed(2)) };
}

async function getJson(url, fetchImpl, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`TomTom HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Route the corridor once through TomTom and resample it. */
export async function resolveCorridor(definition, { key, fetchImpl = fetch }) {
  if (!key) throw new Error('TOMTOM_API_KEY is not set');
  const stops = [definition.from, ...(definition.via || []), definition.to]
    .map((p) => `${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`)
    .join(':');
  const url = `${ROUTING}/${stops}/json?routeType=fastest&traffic=false&travelMode=car&key=${encodeURIComponent(key)}`;
  const payload = await getJson(url, fetchImpl);
  const path = (payload?.routes?.[0]?.legs || []).flatMap((leg) => leg.points || []).map((p) => ({ lat: p.latitude, lon: p.longitude }));
  const count = Math.max(2, Math.min(MAX_POINTS, Number(definition.points) || DEFAULT_POINTS));
  const { points, lengthKm } = resamplePolyline(path, count);
  return {
    id: String(definition.id || definition.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60),
    name: String(definition.name).slice(0, 120),
    definition,
    points,
    lengthKm,
    routeTravelTimeS: num(payload?.routes?.[0]?.summary?.travelTimeInSeconds, 0, 1e6),
  };
}

/** One flow reading per sample point. A point that fails is recorded as null, never invented. */
export async function sampleCorridor(corridor, { key, fetchImpl = fetch, now = () => Date.now() }) {
  const ts = new Date(Math.floor(now() / 60_000) * 60_000).toISOString();
  const rows = new Array(corridor.points.length).fill(null);
  const queue = corridor.points.map((p, index) => ({ p, index }));
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const { p, index } = queue.shift();
        try {
          const url = `${FLOW}?point=${p.lat.toFixed(5)},${p.lon.toFixed(5)}&unit=KMPH&key=${encodeURIComponent(key)}`;
          const d = (await getJson(url, fetchImpl))?.flowSegmentData;
          rows[index] = {
            pointIndex: index,
            currentSpeed: num(d?.currentSpeed, 0, 250),
            freeFlowSpeed: num(d?.freeFlowSpeed, 1, 250),
            currentTravelTime: num(d?.currentTravelTime, 0, 1e6),
            freeFlowTravelTime: num(d?.freeFlowTravelTime, 0, 1e6),
            confidence: num(d?.confidence, 0, 1),
            roadClosure: d?.roadClosure === true ? 1 : 0,
            frc: typeof d?.frc === 'string' ? d.frc.slice(0, 8) : null,
          };
        } catch (error) {
          rows[index] = { pointIndex: index, error: error.message };
        }
      }
    }),
  );
  return { ts, rows };
}

/** SQLite store for corridors and their samples. */
export function createCorridorStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS corridors (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, definition_json TEXT NOT NULL, points_json TEXT NOT NULL,
      length_km REAL, route_travel_time_s REAL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS samples (
      corridor_id TEXT NOT NULL, ts TEXT NOT NULL, point_index INTEGER NOT NULL,
      current_speed REAL, free_flow_speed REAL, current_travel_time REAL, free_flow_travel_time REAL,
      confidence REAL, road_closure INTEGER, frc TEXT, error TEXT,
      PRIMARY KEY (corridor_id, ts, point_index)
    );
    CREATE INDEX IF NOT EXISTS idx_samples_corridor_ts ON samples (corridor_id, ts);
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, corridor_id TEXT, at TEXT NOT NULL, text TEXT NOT NULL
    );
  `);
  const insertSample = db.prepare(`INSERT OR REPLACE INTO samples
    (corridor_id, ts, point_index, current_speed, free_flow_speed, current_travel_time, free_flow_travel_time, confidence, road_closure, frc, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const hydrate = (row) =>
    row && {
      id: row.id,
      name: row.name,
      definition: JSON.parse(row.definition_json),
      points: JSON.parse(row.points_json),
      lengthKm: row.length_km,
      routeTravelTimeS: row.route_travel_time_s,
      createdAt: row.created_at,
    };
  return {
    db,
    listCorridors: () => db.prepare('SELECT * FROM corridors ORDER BY name').all().map(hydrate),
    getCorridor: (id) => hydrate(db.prepare('SELECT * FROM corridors WHERE id = ?').get(id)),
    saveCorridor(c) {
      db.prepare(`INSERT OR REPLACE INTO corridors (id, name, definition_json, points_json, length_km, route_travel_time_s, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(c.id, c.name, JSON.stringify(c.definition), JSON.stringify(c.points), c.lengthKm, c.routeTravelTimeS, new Date().toISOString());
      return this.getCorridor(c.id);
    },
    deleteCorridor(id) {
      db.prepare('DELETE FROM samples WHERE corridor_id = ?').run(id);
      return db.prepare('DELETE FROM corridors WHERE id = ?').run(id).changes === 1;
    },
    saveSamples(corridorId, { ts, rows }) {
      let ok = 0;
      for (const r of rows) {
        if (!r) continue;
        insertSample.run(corridorId, ts, r.pointIndex, r.currentSpeed ?? null, r.freeFlowSpeed ?? null, r.currentTravelTime ?? null,
          r.freeFlowTravelTime ?? null, r.confidence ?? null, r.roadClosure ?? null, r.frc ?? null, r.error ?? null);
        if (!r.error) ok++;
      }
      return { ts, points: rows.length, ok };
    },
    addNote(corridorId, at, text) {
      db.prepare('INSERT INTO notes (corridor_id, at, text) VALUES (?, ?, ?)').run(corridorId || null, at, String(text).slice(0, 500));
    },
    listNotes: (corridorId) => db.prepare('SELECT * FROM notes WHERE corridor_id IS NULL OR corridor_id = ? ORDER BY at').all(corridorId),
    /** Per-timestamp corridor summary between two ISO instants. */
    series(corridorId, fromIso, toIso) {
      return db.prepare(`SELECT ts,
          AVG(CASE WHEN current_speed IS NOT NULL AND free_flow_speed > 0 THEN current_speed / free_flow_speed END) AS speed_ratio,
          AVG(current_speed) AS mean_speed, AVG(free_flow_speed) AS mean_free_flow,
          SUM(current_travel_time) AS travel_time_s, SUM(free_flow_travel_time) AS free_flow_travel_time_s,
          SUM(COALESCE(road_closure, 0)) AS closures, SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) AS points_ok, COUNT(*) AS points
        FROM samples WHERE corridor_id = ? AND ts >= ? AND ts < ? GROUP BY ts ORDER BY ts`).all(corridorId, fromIso, toIso);
    },
    /** Latest reading per point, for a map. */
    latest(corridorId) {
      const last = db.prepare('SELECT MAX(ts) AS ts FROM samples WHERE corridor_id = ?').get(corridorId)?.ts;
      if (!last) return { ts: null, points: [] };
      return { ts: last, points: db.prepare('SELECT * FROM samples WHERE corridor_id = ? AND ts = ? ORDER BY point_index').all(corridorId, last) };
    },
    close: () => db.close(),
  };
}

/** Local-time slot (minutes since midnight, in `offsetMinutes` zone) of an ISO instant. */
export function slotOf(ts, offsetMinutes = 330, slotMinutes = 15) {
  const local = (Date.parse(ts) + offsetMinutes * 60_000) % 86_400_000;
  return Math.floor(((local + 86_400_000) % 86_400_000) / 60_000 / slotMinutes) * slotMinutes;
}

/**
 * Time-of-day profile: mean speed ratio per slot across every day in the
 * window, so period A and period B compare like with like (8:30 vs 8:30).
 */
export function profile(rows, { offsetMinutes = 330, slotMinutes = 15 } = {}) {
  const bins = new Map();
  for (const r of rows) {
    if (r.speed_ratio == null) continue;
    const slot = slotOf(r.ts, offsetMinutes, slotMinutes);
    const b = bins.get(slot) || { slot, n: 0, ratio: 0, speed: 0, travel: 0, closures: 0 };
    b.n++;
    b.ratio += r.speed_ratio;
    b.speed += r.mean_speed || 0;
    b.travel += r.travel_time_s || 0;
    b.closures += r.closures || 0;
    bins.set(slot, b);
  }
  return [...bins.values()]
    .sort((a, b) => a.slot - b.slot)
    .map((b) => ({ slot: b.slot, label: `${String(Math.floor(b.slot / 60)).padStart(2, '0')}:${String(b.slot % 60).padStart(2, '0')}`,
      samples: b.n, speedRatio: b.ratio / b.n, meanSpeed: b.speed / b.n, travelTimeS: b.travel / b.n, closures: b.closures }));
}

/** Slot-by-slot comparison of two profiles, with the worst change called out. */
export function compareProfiles(before, during) {
  const byslot = new Map(before.map((b) => [b.slot, b]));
  const rows = during
    .filter((d) => byslot.has(d.slot))
    .map((d) => {
      const b = byslot.get(d.slot);
      return { slot: d.slot, label: d.label, before: b.speedRatio, during: d.speedRatio, change: d.speedRatio - b.speedRatio,
        beforeSpeed: b.meanSpeed, duringSpeed: d.meanSpeed, beforeTravelS: b.travelTimeS, duringTravelS: d.travelTimeS,
        samplesBefore: b.samples, samplesDuring: d.samples };
    });
  const worst = rows.reduce((w, r) => (w === null || r.change < w.change ? r : w), null);
  const mean = rows.length ? rows.reduce((s, r) => s + r.change, 0) / rows.length : null;
  return { rows, worst, meanChange: mean };
}
