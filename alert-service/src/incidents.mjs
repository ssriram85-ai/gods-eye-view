/**
 * Live traffic incidents for a city (TomTom Traffic Incident Details v5),
 * recorded over time so repeated trouble spots show up: where accidents,
 * breakdowns, flooding and serious jams keep being reported.
 *
 * This is the honest first step towards "predicting accident spots": it
 * does not predict, it counts. Official crash records (FIR locations from
 * the traffic police) would sharpen it; until then the map shows where
 * incidents cluster, labelled as such.
 */
const INCIDENTS = 'https://api.tomtom.com/traffic/services/5/incidentDetails';
const FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,delay,roadNumbers}}}';

export const CATEGORIES = Object.freeze({
  0: 'unknown', 1: 'accident', 2: 'fog', 3: 'dangerous conditions', 4: 'rain', 5: 'ice', 6: 'jam', 7: 'lane closed',
  8: 'road closed', 9: 'road works', 10: 'wind', 11: 'flooding', 14: 'broken-down vehicle',
});
/** Chennai metropolitan area: minLon, minLat, maxLon, maxLat (TomTom caps a box at 10,000 km²). */
export const CHENNAI_BBOX = Object.freeze([80.0, 12.75, 80.35, 13.25]);

/** How much each kind of report counts towards a trouble spot. Planned closures and roadworks do not. */
const WEIGHT = { accident: 5, 'broken-down vehicle': 2, flooding: 3, 'dangerous conditions': 2, jam: 1 };
const CELL_DEG = 0.003; // about 330 m

const num = (v) => (Number.isFinite(v) ? v : null);

function midpoint(geometry) {
  const c = geometry?.coordinates;
  if (!Array.isArray(c) || !c.length) return null;
  const pts = typeof c[0] === 'number' ? [c] : c;
  const p = pts[Math.floor(pts.length / 2)];
  return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? { lon: p[0], lat: p[1] } : null;
}

export function normalizeIncident(raw) {
  const p = raw?.properties || {};
  const at = midpoint(raw?.geometry);
  if (!p.id || !at) return null;
  return {
    id: String(p.id).slice(0, 120),
    category: CATEGORIES[p.iconCategory] || 'unknown',
    icon: num(p.iconCategory),
    magnitude: num(p.magnitudeOfDelay),
    delayS: num(p.delay),
    lengthM: num(p.length),
    road: Array.isArray(p.roadNumbers) ? p.roadNumbers.join(', ').slice(0, 60) : null,
    from: p.from ? String(p.from).slice(0, 120) : null,
    to: p.to ? String(p.to).slice(0, 120) : null,
    description: p.events?.[0]?.description ? String(p.events[0].description).slice(0, 160) : null,
    startTime: p.startTime || null,
    endTime: p.endTime || null,
    lat: at.lat,
    lon: at.lon,
  };
}

export async function fetchIncidents({ key, bbox = CHENNAI_BBOX, fetchImpl = fetch, timeoutMs = 30_000 }) {
  if (!key) throw new Error('TOMTOM_API_KEY is not set');
  const params = new URLSearchParams({ bbox: bbox.join(','), fields: FIELDS, language: 'en-GB', timeValidityFilter: 'present', key });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${INCIDENTS}?${params}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`TomTom incidents HTTP ${r.status}`);
    return ((await r.json())?.incidents || []).map(normalizeIncident).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

export function createIncidentStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, category TEXT, icon INTEGER, magnitude INTEGER, delay_s REAL, max_delay_s REAL, length_m REAL,
      road TEXT, from_name TEXT, to_name TEXT, description TEXT, start_time TEXT, end_time TEXT,
      lat REAL, lon REAL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, polls INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_seen ON incidents (last_seen);
    CREATE INDEX IF NOT EXISTS idx_incidents_cat ON incidents (category, first_seen);
  `);
  const upsert = db.prepare(`INSERT INTO incidents
      (id, category, icon, magnitude, delay_s, max_delay_s, length_m, road, from_name, to_name, description, start_time, end_time, lat, lon, first_seen, last_seen, polls)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET category = excluded.category, magnitude = excluded.magnitude, delay_s = excluded.delay_s,
      max_delay_s = MAX(COALESCE(incidents.max_delay_s, 0), COALESCE(excluded.delay_s, 0)), description = excluded.description,
      end_time = excluded.end_time, last_seen = excluded.last_seen, polls = incidents.polls + 1`);
  let lastPoll = null;
  return {
    record(list, at = new Date().toISOString()) {
      for (const i of list)
        upsert.run(i.id, i.category, i.icon, i.magnitude, i.delayS, i.delayS, i.lengthM, i.road, i.from, i.to, i.description, i.startTime, i.endTime, i.lat, i.lon, at, at);
      lastPoll = { at, count: list.length };
      return lastPoll;
    },
    lastPoll: () => lastPoll,
    /** Incidents seen in the latest poll. */
    current() {
      const at = lastPoll?.at || db.prepare('SELECT MAX(last_seen) AS at FROM incidents').get()?.at;
      return at ? db.prepare('SELECT * FROM incidents WHERE last_seen = ? ORDER BY COALESCE(delay_s, 0) DESC').all(at) : [];
    },
    since: (fromIso) => db.prepare('SELECT * FROM incidents WHERE last_seen >= ? ORDER BY first_seen').all(fromIso),
    counts: (fromIso) => db.prepare('SELECT category, COUNT(*) AS n FROM incidents WHERE first_seen >= ? GROUP BY category ORDER BY n DESC').all(fromIso),
    firstSeen: () => db.prepare('SELECT MIN(first_seen) AS at FROM incidents').get()?.at || null,
  };
}

/**
 * Trouble spots: incidents grouped into ~330 m cells, weighted by kind,
 * counting a recurring jam once per day it appears. Road closures and
 * roadworks are left out (they are planned, not hazards of the road).
 */
export function hotspots(incidents, { limit = 12, minScore = 3 } = {}) {
  const cells = new Map();
  for (const i of incidents) {
    const w = WEIGHT[i.category];
    if (!w || i.lat == null) continue;
    if (i.category === 'jam' && (i.magnitude ?? 0) < 3) continue; // only major jams
    const key = `${Math.round(i.lat / CELL_DEG)}:${Math.round(i.lon / CELL_DEG)}`;
    const c = cells.get(key) || { key, lat: 0, lon: 0, n: 0, score: 0, kinds: {}, days: new Set(), names: new Map(), latest: null };
    const day = String(i.first_seen || i.last_seen || '').slice(0, 10);
    const jamDayKey = `jam:${day}`;
    if (i.category === 'jam' && c.days.has(jamDayKey)) continue;
    if (i.category === 'jam') c.days.add(jamDayKey);
    c.days.add(day);
    c.n++;
    c.score += w;
    c.lat += i.lat;
    c.lon += i.lon;
    c.kinds[i.category] = (c.kinds[i.category] || 0) + 1;
    const name = [i.from_name, i.to_name].filter(Boolean).join(' → ') || i.road || null;
    if (name) c.names.set(name, (c.names.get(name) || 0) + 1);
    if (!c.latest || (i.last_seen || '') > c.latest) c.latest = i.last_seen;
    cells.set(key, c);
  }
  return [...cells.values()]
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => ({
      lat: Number((c.lat / c.n).toFixed(5)),
      lon: Number((c.lon / c.n).toFixed(5)),
      score: c.score,
      reports: c.n,
      days: [...c.days].filter((d) => !d.startsWith('jam:')).length,
      kinds: c.kinds,
      place: [...c.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      latest: c.latest,
    }));
}

/**
 * Recurring jams: places where TomTom reports a major jam (magnitude 3–4 or
 * at least five minutes of delay) on several different days. Ranked by
 * days seen, then by typical delay. This is what the incident feed can
 * honestly show for Chennai today; it reports almost no accidents.
 */
export function recurringJams(incidents, { limit = 12, minDays = 2 } = {}) {
  const cells = new Map();
  for (const i of incidents) {
    if (i.category !== 'jam' || i.lat == null) continue;
    const delay = Math.max(i.max_delay_s || 0, i.delay_s || 0);
    if ((i.magnitude ?? 0) < 3 && delay < 300) continue;
    const key = `${Math.round(i.lat / CELL_DEG)}:${Math.round(i.lon / CELL_DEG)}`;
    const c = cells.get(key) || { lat: 0, lon: 0, n: 0, days: new Set(), delays: [], names: new Map(), latest: null };
    c.n++;
    c.lat += i.lat;
    c.lon += i.lon;
    for (let t = Date.parse(i.first_seen), end = Date.parse(i.last_seen || i.first_seen); t <= end; t += 86_400_000)
      c.days.add(new Date(t + 330 * 60_000).toISOString().slice(0, 10));
    c.days.add(new Date(Date.parse(i.last_seen || i.first_seen) + 330 * 60_000).toISOString().slice(0, 10));
    if (delay) c.delays.push(delay);
    const name = [i.from_name, i.to_name].filter(Boolean).join(' → ') || i.road || null;
    if (name) c.names.set(name, (c.names.get(name) || 0) + 1);
    if (!c.latest || (i.last_seen || '') > c.latest) c.latest = i.last_seen;
    cells.set(key, c);
  }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  return [...cells.values()]
    .filter((c) => c.days.size >= minDays)
    .map((c) => ({
      lat: Number((c.lat / c.n).toFixed(5)),
      lon: Number((c.lon / c.n).toFixed(5)),
      days: c.days.size,
      reports: c.n,
      typicalDelayMinutes: c.delays.length ? Math.round(med(c.delays) / 60) : null,
      place: [...c.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      latest: c.latest,
    }))
    .sort((a, b) => b.days - a.days || (b.typicalDelayMinutes || 0) - (a.typicalDelayMinutes || 0))
    .slice(0, limit);
}

/** Safety spots: accidents, flooding, breakdowns and dangerous conditions only. */
export function safetySpots(incidents, opts = {}) {
  return hotspots(incidents.filter((i) => i.category !== 'jam'), { minScore: 2, ...opts });
}
