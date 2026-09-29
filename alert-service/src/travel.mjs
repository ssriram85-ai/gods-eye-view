/**
 * Section travel times: how many minutes each named stretch of a road takes
 * right now, what TomTom's history says it usually takes at this hour, and
 * what it takes on an empty road.
 *
 * Why not point speeds: TomTom's Flow Segment Data returns the whole road
 * segment a point falls on, and on OMR a single segment runs for most of
 * the corridor, so twelve sample points collapse into two or three averaged
 * readings and a jam at one junction disappears. The routing API with live
 * traffic measures the drive itself, leg by leg.
 *
 * A corridor is a list of named stops along one road in one direction. It
 * is resolved once (a no-traffic route through every stop); the leg ends of
 * that route become the sampling waypoints, so they sit on the right
 * carriageway. Each sample is one routing call per corridor.
 */
import { haversineKm } from './geo.mjs';

const ROUTING = 'https://api.tomtom.com/routing/1/calculateRoute';
const num = (v, lo = 0, hi = 1e7) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** The roads the monitor records, each in both directions. Stops are in outbound order. */
export const ROADS = Object.freeze([
  {
    road: 'omr',
    label: 'OMR',
    outbound: 'southbound',
    inbound: 'northbound',
    ids: ['omr-south', 'omr-north'],
    stops: [
      { name: 'Madhya Kailash', lat: 13.0067, lon: 80.254 },
      { name: 'Tidel Park', lat: 12.9894, lon: 80.2486 },
      { name: 'Perungudi', lat: 12.9606, lon: 80.2451 },
      { name: 'Thoraipakkam', lat: 12.9395, lon: 80.2368 },
      { name: 'Sholinganallur', lat: 12.901, lon: 80.2279 },
      { name: 'Navalur', lat: 12.844, lon: 80.227 },
      { name: 'Siruseri', lat: 12.825, lon: 80.22 },
    ],
  },
  {
    road: 'anna-salai',
    label: 'Anna Salai',
    outbound: 'northbound',
    inbound: 'southbound',
    ids: ['anna-salai-north', 'anna-salai-south'],
    stops: [
      { name: 'Kathipara', lat: 13.0067, lon: 80.2052 },
      { name: 'Saidapet', lat: 13.0213, lon: 80.2231 },
      { name: 'Nandanam', lat: 13.0305, lon: 80.241 },
      { name: 'Teynampet', lat: 13.0405, lon: 80.2505 },
      { name: 'Gemini', lat: 13.0507, lon: 80.2488 },
      { name: 'Spencer Plaza', lat: 13.0613, lon: 80.2622 },
      { name: 'Anna Statue', lat: 13.0667, lon: 80.2717 },
    ],
  },
  {
    road: 'gst',
    label: 'GST Road',
    outbound: 'southbound',
    inbound: 'northbound',
    ids: ['gst-south', 'gst-north'],
    stops: [
      { name: 'Kathipara', lat: 13.0067, lon: 80.2052 },
      { name: 'Airport', lat: 12.99, lon: 80.176 },
      { name: 'Pallavaram', lat: 12.9675, lon: 80.1491 },
      { name: 'Chromepet', lat: 12.9516, lon: 80.1413 },
      { name: 'Tambaram', lat: 12.9249, lon: 80.1275 },
      { name: 'Perungalathur', lat: 12.905, lon: 80.0967 },
      { name: 'Vandalur', lat: 12.879, lon: 80.0819 },
    ],
  },
  {
    road: 'ecr',
    label: 'ECR',
    outbound: 'southbound',
    inbound: 'northbound',
    ids: ['ecr-south', 'ecr-north'],
    stops: [
      { name: 'Thiruvanmiyur', lat: 12.983, lon: 80.2594 },
      { name: 'Kottivakkam', lat: 12.968, lon: 80.2595 },
      { name: 'Neelankarai', lat: 12.9493, lon: 80.2546 },
      { name: 'Injambakkam', lat: 12.918, lon: 80.25 },
      { name: 'Akkarai', lat: 12.89, lon: 80.249 },
      { name: 'Uthandi', lat: 12.8661, lon: 80.2427 },
    ],
  },
]);

/** One definition per road and direction, ready for resolveSections. */
export function corridorDefinitions(roads = ROADS) {
  return roads.flatMap((r) => {
    const out = r.stops, back = [...r.stops].reverse();
    return [
      { id: r.ids[0], road: r.road, direction: r.outbound, name: `${r.label} ${r.outbound} · ${out[0].name} → ${out[out.length - 1].name}`, stops: out },
      { id: r.ids[1], road: r.road, direction: r.inbound, name: `${r.label} ${r.inbound} · ${back[0].name} → ${back[back.length - 1].name}`, stops: back },
    ];
  });
}

async function getJson(url, fetchImpl, timeoutMs = 25_000) {
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
const coords = (list) => list.map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lon).toFixed(6)}`).join(':');

const SNAP_KM = 0.6;

/** Nearest path index at or after `from` to a point, with its distance in km. */
function nearestAfter(path, from, lat, lon) {
  let best = -1, bestKm = Infinity;
  for (let i = from; i < path.length; i++) {
    const d = haversineKm(lat, lon, path[i].lat, path[i].lon);
    if (d < bestKm) (bestKm = d), (best = i);
  }
  return { index: best, km: bestKm };
}

async function routePath(stops, { key, fetchImpl }) {
  const url = `${ROUTING}/${coords(stops)}/json?routeType=fastest&traffic=false&travelMode=car&key=${encodeURIComponent(key)}`;
  const route = (await getJson(url, fetchImpl))?.routes?.[0];
  const path = (route?.legs || []).flatMap((l) => l.points || []).map((p) => ({ lat: p.latitude, lon: p.longitude }));
  if (path.length < 2) throw new Error('routing returned no path');
  return trimEndLoops(path, stops[0], stops[stops.length - 1]);
}

/**
 * An end placed on the far carriageway makes the route drive away, U-turn
 * and pass the end again. Start from the last pass near the first stop and
 * finish at the first pass near the last stop, within the outer 40% each.
 */
export function trimEndLoops(path, first, last, radiusKm = 0.25) {
  const n = path.length;
  /** Index of the closest point on the last return past `p`, scanning `order`; -1 if the path never comes back. */
  const reentry = (p, order) => {
    let left = false, best = -1, bestKm = Infinity;
    for (const i of order) {
      const d = haversineKm(p.lat, p.lon, path[i].lat, path[i].lon);
      if (d > radiusKm) {
        if (best >= 0) break; // the return pass is over
        left = true;
      } else if (left && d < bestKm) (best = i), (bestKm = d);
    }
    return best;
  };
  const head = Array.from({ length: Math.floor(n * 0.4) }, (_, i) => i);
  const tail = Array.from({ length: Math.floor(n * 0.4) }, (_, i) => n - 1 - i);
  const a = Math.max(0, reentry(first, head));
  const bHit = reentry(last, tail);
  const b = bHit < 0 ? n - 1 : bHit;
  return b - a >= 1 ? path.slice(a, b + 1) : path;
}

/**
 * Resolve a definition into waypoints on the right carriageway and named
 * sections. The road is routed end to end first and every named stop is
 * snapped onto that path in order, so a stop placed on a side street or the
 * opposite carriageway cannot add a loop. A stop the direct route misses
 * (the fastest way leaves the road) is routed through instead, and noted.
 */
export async function resolveSections(definition, { key, fetchImpl = fetch }) {
  if (!key) throw new Error('TOMTOM_API_KEY is not set');
  const stops = definition.stops;
  if (!Array.isArray(stops) || stops.length < 2) throw new Error('a corridor needs at least two stops');
  const warnings = [];
  const snapAll = (path) => {
    let from = 0;
    return stops.slice(1, -1).map((s) => {
      const hit = nearestAfter(path, from, s.lat, s.lon);
      from = Math.max(from, hit.index);
      return { ...hit, stop: s };
    });
  };
  let path = await routePath([stops[0], stops[stops.length - 1]], { key, fetchImpl });
  let snaps = snapAll(path);
  const missed = snaps.filter((h) => h.km > SNAP_KM).map((h) => h.stop);
  if (missed.length) {
    warnings.push(`the fastest route leaves the road near ${missed.map((m) => m.name).join(', ')}; routed through ${missed.length > 1 ? 'them' : 'it'}`);
    path = await routePath([stops[0], ...missed, stops[stops.length - 1]], { key, fetchImpl });
    snaps = snapAll(path);
  }
  for (const h of snaps) if (h.km > SNAP_KM) warnings.push(`${h.stop.name} is ${h.km.toFixed(1)} km from the road; check its coordinates`);
  const cumulative = [0];
  for (let i = 1; i < path.length; i++) cumulative.push(cumulative[i - 1] + haversineKm(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon));
  const indices = [0, ...snaps.map((h) => h.index), path.length - 1];
  const waypoints = indices.map((idx, k) => ({ lat: Number(path[idx].lat.toFixed(6)), lon: Number(path[idx].lon.toFixed(6)), name: stops[k].name, km: Number(cumulative[idx].toFixed(2)) }));
  const sections = stops.slice(0, -1).map((s, i) => ({ index: i, from: s.name, to: stops[i + 1].name, lengthKm: Number((cumulative[indices[i + 1]] - cumulative[indices[i]]).toFixed(2)) }));
  // Keep a light copy of the road for maps: about one point every 150 m.
  const step = Math.max(1, Math.floor(path.length / Math.max(2, Math.ceil(cumulative[cumulative.length - 1] / 0.15))));
  const line = path.filter((_, i) => i % step === 0 || i === path.length - 1).map((p) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))]);
  return {
    id: definition.id,
    name: definition.name,
    definition: { ...definition, version: 2, sections, warnings, line },
    points: waypoints,
    lengthKm: Number(cumulative[cumulative.length - 1].toFixed(2)),
    routeTravelTimeS: null,
  };
}

const JAM_KINDS = { JAM: 'jam', ROAD_WORK: 'roadworks', ROAD_CLOSURE: 'closure', OTHER: 'other' };

/** One live reading per section, plus where the route's jams are. One routing call. */
export async function sampleSections(corridor, { key, fetchImpl = fetch, now = () => Date.now() }) {
  const ts = new Date(Math.floor(now() / 60_000) * 60_000).toISOString();
  const url = `${ROUTING}/${coords(corridor.points)}/json?routeType=fastest&traffic=true&travelMode=car&computeTravelTimeFor=all&sectionType=traffic&key=${encodeURIComponent(key)}`;
  const route = (await getJson(url, fetchImpl))?.routes?.[0];
  const legs = route?.legs || [];
  if (legs.length !== corridor.points.length - 1) throw new Error(`routing returned ${legs.length} legs for ${corridor.points.length - 1} sections`);
  const lengthKm = (route.summary?.lengthInMeters || 0) / 1000;
  // A live route much longer than the resolved one left the road (a closure or a faster parallel road).
  const detour = corridor.lengthKm && lengthKm > corridor.lengthKm * 1.15 ? 1 : 0;
  const rows = legs.map((leg, i) => {
    const s = leg.summary || {};
    return {
      leg: i,
      lengthM: num(s.lengthInMeters),
      travelS: num(s.travelTimeInSeconds),
      noTrafficS: num(s.noTrafficTravelTimeInSeconds),
      historicS: num(s.historicTrafficTravelTimeInSeconds),
      incidentsS: num(s.liveTrafficIncidentsTravelTimeInSeconds),
      delayS: num(s.trafficDelayInSeconds),
      detour,
    };
  });
  // Map route point indices to legs and to distance along the corridor.
  const points = legs.flatMap((l) => l.points || []);
  const legOfPoint = legs.flatMap((l, i) => (l.points || []).map(() => i));
  const kmAt = [0];
  for (let i = 1; i < points.length; i++) kmAt.push(kmAt[i - 1] + haversineKm(points[i - 1].latitude, points[i - 1].longitude, points[i].latitude, points[i].longitude));
  const jams = (route.sections || [])
    .filter((s) => s.sectionType === 'TRAFFIC')
    .map((s) => {
      const a = Math.max(0, Math.min(points.length - 1, s.startPointIndex ?? 0));
      const b = Math.max(a, Math.min(points.length - 1, s.endPointIndex ?? a));
      const mid = points[Math.floor((a + b) / 2)];
      return {
        leg: legOfPoint[a] ?? null,
        category: JAM_KINDS[s.simpleCategory] || 'other',
        magnitude: num(s.magnitudeOfDelay, 0, 4),
        delayS: num(s.delayInSeconds),
        startKm: Number(kmAt[a].toFixed(2)),
        endKm: Number(kmAt[b].toFixed(2)),
        lat: mid?.latitude ?? null,
        lon: mid?.longitude ?? null,
      };
    });
  return { ts, rows, jams, lengthKm: Number(lengthKm.toFixed(2)), detour };
}

/** Section-sample tables beside the corridor tables, on the same database. */
export function createTravelStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_samples (
      corridor_id TEXT NOT NULL, ts TEXT NOT NULL, leg INTEGER NOT NULL,
      length_m REAL, travel_s REAL, no_traffic_s REAL, historic_s REAL, incidents_s REAL, delay_s REAL, detour INTEGER,
      PRIMARY KEY (corridor_id, ts, leg)
    );
    CREATE INDEX IF NOT EXISTS idx_route_samples_ts ON route_samples (corridor_id, ts);
    CREATE TABLE IF NOT EXISTS route_jams (
      corridor_id TEXT NOT NULL, ts TEXT NOT NULL, leg INTEGER, category TEXT, magnitude INTEGER, delay_s REAL,
      start_km REAL, end_km REAL, lat REAL, lon REAL
    );
    CREATE INDEX IF NOT EXISTS idx_route_jams_ts ON route_jams (corridor_id, ts);
  `);
  const insertRow = db.prepare(`INSERT OR REPLACE INTO route_samples
    (corridor_id, ts, leg, length_m, travel_s, no_traffic_s, historic_s, incidents_s, delay_s, detour) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertJam = db.prepare(`INSERT INTO route_jams (corridor_id, ts, leg, category, magnitude, delay_s, start_km, end_km, lat, lon)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return {
    save(corridorId, { ts, rows, jams }) {
      db.prepare('DELETE FROM route_jams WHERE corridor_id = ? AND ts = ?').run(corridorId, ts);
      for (const r of rows) insertRow.run(corridorId, ts, r.leg, r.lengthM, r.travelS, r.noTrafficS, r.historicS, r.incidentsS, r.delayS, r.detour ?? 0);
      for (const j of jams || []) insertJam.run(corridorId, ts, j.leg, j.category, j.magnitude, j.delayS, j.startKm, j.endKm, j.lat, j.lon);
      return { ts, sections: rows.length, jams: (jams || []).length };
    },
    /** Every section row between two ISO instants. */
    rows: (corridorId, fromIso, toIso) =>
      db.prepare('SELECT * FROM route_samples WHERE corridor_id = ? AND ts >= ? AND ts < ? ORDER BY ts, leg').all(corridorId, fromIso, toIso),
    /** Whole-corridor totals per sample time. */
    totals: (corridorId, fromIso, toIso) =>
      db.prepare(`SELECT ts, SUM(travel_s) AS travel_s, SUM(no_traffic_s) AS no_traffic_s, SUM(historic_s) AS historic_s,
          SUM(delay_s) AS delay_s, MAX(detour) AS detour, COUNT(*) AS legs
        FROM route_samples WHERE corridor_id = ? AND ts >= ? AND ts < ? GROUP BY ts ORDER BY ts`).all(corridorId, fromIso, toIso),
    latest(corridorId) {
      const ts = db.prepare('SELECT MAX(ts) AS ts FROM route_samples WHERE corridor_id = ?').get(corridorId)?.ts;
      if (!ts) return { ts: null, rows: [], jams: [] };
      return {
        ts,
        rows: db.prepare('SELECT * FROM route_samples WHERE corridor_id = ? AND ts = ? ORDER BY leg').all(corridorId, ts),
        jams: db.prepare('SELECT * FROM route_jams WHERE corridor_id = ? AND ts = ? ORDER BY start_km').all(corridorId, ts),
      };
    },
    jams: (corridorId, fromIso, toIso) =>
      db.prepare('SELECT * FROM route_jams WHERE corridor_id = ? AND ts >= ? AND ts < ? ORDER BY ts').all(corridorId, fromIso, toIso),
    count: (corridorId) => db.prepare('SELECT COUNT(DISTINCT ts) AS n FROM route_samples WHERE corridor_id = ?').get(corridorId)?.n || 0,
  };
}
