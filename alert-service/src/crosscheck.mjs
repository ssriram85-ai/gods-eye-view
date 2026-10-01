/**
 * Second-source check: Google's live-traffic drive for the same road, at
 * the same moment as a TomTom reading, compared and then discarded.
 *
 * Google Maps Platform terms (Service Specific Terms §19.3 for the Routes
 * API) allow caching only latitude/longitude, for 30 days; travel times may
 * not be stored. So nothing Google returns is kept: the service keeps only
 * the outcome of each comparison (agreement band, whether both sources saw
 * congestion, how many stretches agreed). Those outcomes are what a panel
 * needs: how often two independent sources agree.
 *
 * Volume: one Routes request per road per check (Compute Routes Pro, free
 * up to 5,000 a month). Checks run on the hours in GOOGLE_CHECK_HOURS (IST)
 * and stop for the month at GOOGLE_MONTHLY_CAP.
 */
const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELDS = 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.legs.duration,routes.legs.staticDuration,routes.legs.distanceMeters';
const IST_MS = 330 * 60_000;

const secs = (d) => {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d || ''));
  return m ? Number(m[1]) : null;
};
/** Compass bearing from a to b, degrees 0–359. */
export function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return Math.round(((Math.atan2(y, x) / r) % 360 + 360) % 360);
}
/**
 * A waypoint pinned to the direction of travel, so Google snaps it to the
 * same carriageway TomTom used (the waypoints sit on that carriageway).
 */
const waypoint = (pts, i) => {
  const p = pts[i];
  const from = pts[Math.max(0, i - 1)], to = pts[Math.min(pts.length - 1, i + 1)];
  const heading = i === 0 ? bearing(p, to) : i === pts.length - 1 ? bearing(from, p) : bearing(from, to);
  return { location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lon) }, heading }, sideOfRoad: true };
};

/** Parse "3,6-23" into a set of IST hours. */
export function parseHours(spec = '3,6-23') {
  const hours = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] == null ? a : Number(m[2]);
    for (let h = Math.min(a, b); h <= Math.max(a, b) && h < 24; h++) hours.add(h);
  }
  return hours;
}
export const istHour = (ms = Date.now()) => new Date(ms + IST_MS).getUTCHours();
export const istMonth = (ms = Date.now()) => new Date(ms + IST_MS).toISOString().slice(0, 7);

/** Ask Google for the live drive through the corridor's waypoints. Returns transient numbers only. */
export async function googleDrive(corridor, { key, fetchImpl = fetch, timeoutMs = 25_000 }) {
  if (!key) throw new Error('GOOGLE_ROUTES_API_KEY is not set');
  const pts = corridor.points;
  const body = {
    origin: waypoint(pts, 0),
    destination: waypoint(pts, pts.length - 1),
    intermediates: pts.slice(1, -1).map((_, k) => waypoint(pts, k + 1)),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: false,
    units: 'METRIC',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(ROUTES, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let detail = '';
      try {
        detail = (await r.json())?.error?.message || '';
      } catch {}
      throw new Error(`Google Routes HTTP ${r.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    const route = (await r.json())?.routes?.[0];
    if (!route) throw new Error('Google Routes returned no route');
    return {
      seconds: secs(route.duration),
      staticSeconds: secs(route.staticDuration),
      meters: route.distanceMeters ?? null,
      legs: (route.legs || []).map((l) => ({ seconds: secs(l.duration), meters: l.distanceMeters ?? null })),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare one Google answer with the TomTom reading for the same moment and
 * return only the outcome. `tomtom` is { rows: route_samples rows } from the
 * same corridor; `lengthKm` is the corridor's resolved length.
 */
export function compareDrives(google, tomtom, lengthKm) {
  const rows = tomtom?.rows || [];
  const t = rows.reduce((a, r) => a + (r.travel_s || 0), 0);
  const tFree = rows.reduce((a, r) => a + (r.no_traffic_s || 0), 0);
  if (!google?.seconds || !t) return { outcome: 'no-data' };
  if (google.meters && lengthKm && Math.abs(google.meters / 1000 - lengthKm) / lengthKm > 0.1)
    return { outcome: 'route-differs', note: google.meters / 1000 > lengthKm ? 'longer' : 'shorter' };
  const diff = (t - google.seconds) / google.seconds;
  const outcome = Math.abs(diff) <= 0.1 ? 'within10' : Math.abs(diff) <= 0.2 ? 'within20' : diff > 0 ? 'tomtom-higher' : 'tomtom-lower';
  const gCongested = google.staticSeconds ? google.seconds / google.staticSeconds >= 1.2 : null;
  const tCongested = tFree ? t / tFree >= 1.2 : null;
  const congestionAgree = gCongested == null || tCongested == null ? null : gCongested === tCongested ? 1 : 0;
  let legsWithin20 = null;
  if (google.legs?.length === rows.length) {
    legsWithin20 = 0;
    google.legs.forEach((g, i) => {
      const leg = rows.find((r) => r.leg === i);
      if (g.seconds && leg?.travel_s && Math.abs(leg.travel_s - g.seconds) / g.seconds <= 0.2) legsWithin20++;
    });
  }
  return { outcome, congestionAgree, legsWithin20, legs: rows.length };
}

export function createCrossCheckStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crosscheck (
      corridor_id TEXT NOT NULL, ts TEXT NOT NULL, tomtom_ts TEXT, outcome TEXT NOT NULL,
      congestion_agree INTEGER, legs_within20 INTEGER, legs INTEGER, error TEXT,
      PRIMARY KEY (corridor_id, ts)
    );
  `);
  const insert = db.prepare('INSERT OR REPLACE INTO crosscheck (corridor_id, ts, tomtom_ts, outcome, congestion_agree, legs_within20, legs, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  return {
    record: (corridorId, ts, tomtomTs, r) => insert.run(corridorId, ts, tomtomTs ?? null, r.outcome, r.congestionAgree ?? null, r.legsWithin20 ?? null, r.legs ?? null, r.error ?? null),
    /** Requests made in an IST calendar month (errors included: they may still be billed). */
    callsInMonth(month) {
      const start = new Date(Date.parse(`${month}-01T00:00:00+05:30`)).toISOString();
      const [y, m] = month.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      const end = new Date(Date.parse(`${next}-01T00:00:00+05:30`)).toISOString();
      return db.prepare("SELECT COUNT(*) AS n FROM crosscheck WHERE ts >= ? AND ts < ? AND outcome != 'skipped'").get(start, end).n;
    },
    lastHourKey: () => db.prepare('SELECT MAX(ts) AS ts FROM crosscheck').get()?.ts || null,
    /** Agreement per corridor since an instant. */
    summary(fromIso) {
      return db.prepare(`SELECT corridor_id,
          COUNT(*) AS checks,
          SUM(CASE WHEN outcome IN ('within10','within20','tomtom-higher','tomtom-lower') THEN 1 ELSE 0 END) AS compared,
          SUM(CASE WHEN outcome = 'within10' THEN 1 ELSE 0 END) AS within10,
          SUM(CASE WHEN outcome IN ('within10','within20') THEN 1 ELSE 0 END) AS within20,
          SUM(CASE WHEN outcome = 'tomtom-higher' THEN 1 ELSE 0 END) AS tomtom_higher,
          SUM(CASE WHEN outcome = 'tomtom-lower' THEN 1 ELSE 0 END) AS tomtom_lower,
          SUM(CASE WHEN outcome = 'route-differs' THEN 1 ELSE 0 END) AS route_differs,
          SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
          SUM(COALESCE(congestion_agree, 0)) AS congestion_agree, SUM(CASE WHEN congestion_agree IS NULL THEN 0 ELSE 1 END) AS congestion_known,
          SUM(COALESCE(legs_within20, 0)) AS legs_within20, SUM(CASE WHEN legs_within20 IS NULL THEN 0 ELSE legs END) AS legs_known,
          MIN(ts) AS first, MAX(ts) AS last
        FROM crosscheck WHERE ts >= ? GROUP BY corridor_id`).all(fromIso);
    },
  };
}

/** Plain-language agreement for one corridor's summary row. */
export function agreementText(row) {
  if (!row || !row.compared) return 'no comparisons yet';
  const pct = (a, b) => `${Math.round((a / b) * 100)}%`;
  const parts = [`within 10% of Google in ${pct(row.within10, row.compared)} and within 20% in ${pct(row.within20, row.compared)} of ${row.compared} checks`];
  if (row.congestion_known) parts.push(`both sources agreed on whether the road was congested ${pct(row.congestion_agree, row.congestion_known)} of the time`);
  if (row.legs_known) parts.push(`stretch by stretch, ${pct(row.legs_within20, row.legs_known)} within 20%`);
  return parts.join('; ');
}
