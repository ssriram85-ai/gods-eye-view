/**
 * Pull God's Eye View's hazard endpoints and normalize them into one event
 * shape. Geometry is one of:
 *   { type: 'polygon', rings: [[[lon,lat],...], ...] }
 *   { type: 'line', points: [[lon,lat],...], radiusKm }
 *   { type: 'point', lat, lon, radiusKm }
 */
export const SEVERITIES = ['info', 'warning', 'critical'];
export const severityRank = (s) => Math.max(0, SEVERITIES.indexOf(s));

const SACHET_SEVERITY = { Extreme: 'critical', Severe: 'warning', Moderate: 'info', Minor: 'info', Unknown: 'info' };
const JTWC_CORRIDOR_KM = 150;
const HEAT_CITY_RADIUS_KM = 40;

export function normalizeSachet(snapshot) {
  if (!snapshot || snapshot.unavailable) return [];
  return snapshot.alerts
    .filter((a) => Array.isArray(a.polygons) && a.polygons.length)
    .map((a) => ({
      id: `sachet:${a.id}`,
      source: 'sachet',
      category: a.category,
      event: a.event,
      severity: SACHET_SEVERITY[a.severity] || 'info',
      headline: a.headline || a.event,
      instruction: a.instruction || '',
      sender: a.sender,
      onset: a.onset,
      expires: a.expires,
      url: a.capUrl,
      geometry: { type: 'polygon', rings: a.polygons },
    }));
}

export function normalizeJtwc(snapshot) {
  if (!snapshot || snapshot.unavailable) return [];
  const events = [];
  for (const s of snapshot.storms) {
    const base = {
      source: 'jtwc',
      category: 'cyclone',
      sender: 'JTWC',
      onset: s.issuedAt,
      expires: null,
      url: s.advisoryUrl,
    };
    const name = `${s.name} (${s.classification}, ${s.windKt ?? '?'} kt)`;
    if (s.cone?.coordinates?.length)
      events.push({
        ...base,
        id: `jtwc:${s.id}:${s.advisoryNumber}:swath`,
        event: `Tropical cyclone ${name}`,
        severity: 'critical',
        headline: `Inside JTWC 34-knot danger swath of ${name}, warning ${s.advisoryNumber}`,
        instruction: 'Gale-force winds possible along the forecast track. Follow IMD bulletins.',
        geometry: { type: 'polygon', rings: s.cone.coordinates.map((ring) => ring) },
      });
    const points = s.track?.coordinates || (s.forecastPoints || []).map((p) => [p.position.longitude, p.position.latitude]);
    if (points.length)
      events.push({
        ...base,
        id: `jtwc:${s.id}:${s.advisoryNumber}:corridor`,
        event: `Tropical cyclone ${name}`,
        severity: 'warning',
        headline: `Within ${JTWC_CORRIDOR_KM} km of the forecast track of ${name}, warning ${s.advisoryNumber}`,
        instruction: 'Track uncertainty is large; prepare for heavy rain and wind. Follow IMD bulletins.',
        geometry: { type: 'line', points, radiusKm: JTWC_CORRIDOR_KM },
      });
  }
  return events;
}

function heatSeverity(feelsLikeC) {
  if (feelsLikeC >= 54) return 'critical';
  if (feelsLikeC >= 41) return 'critical';
  if (feelsLikeC >= 32) return 'warning';
  return 'info';
}

export function normalizeHeat(snapshot) {
  if (!snapshot || snapshot.unavailable) return [];
  const day = (snapshot.samples[0]?.observedAt || new Date().toISOString()).slice(0, 10);
  return snapshot.samples.map((s) => {
    const peak = Math.max(s.feelsLikeC, s.feelsLikeMaxTodayC ?? -Infinity);
    return {
      id: `heat:${s.id}:${day}`,
      source: 'heat',
      category: 'heat',
      event: 'Heat stress',
      severity: heatSeverity(peak),
      headline: `${s.name}: feels like ${Math.round(s.feelsLikeC)}° now, ${s.feelsLikeMaxTodayC == null ? '—' : Math.round(s.feelsLikeMaxTodayC) + '°'} today's forecast peak${s.imdThresholdMet ? ' · IMD heat-wave temperature threshold reached' : ''}`,
      instruction: 'Check cold-chain and ambient storage; shorten shelf-life assumptions for perishables.',
      sender: 'Open-Meteo',
      onset: s.observedAt,
      expires: null,
      url: null,
      value: { feelsLikeC: s.feelsLikeC, peakC: peak, airMaxTodayC: s.airMaxTodayC, imdThresholdMet: s.imdThresholdMet },
      geometry: { type: 'point', lat: s.position.latitude, lon: s.position.longitude, radiusKm: HEAT_CITY_RADIUS_KM },
    };
  });
}

async function getJson(url, fetchImpl, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json', ...headers } });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch every feed; a feed that fails is reported, never fabricated. A GEV
 * behind its login gate is opened with `gateToken` (its GEV_GATE_PASSWORD).
 */
export async function fetchEvents({ baseUrl, fetchImpl = fetch, timeoutMs = 90_000, gateToken = '' }) {
  const headers = gateToken ? { Authorization: `Bearer ${gateToken}` } : {};
  const feeds = [
    ['sachet', '/api/sachet', normalizeSachet],
    ['jtwc', '/api/jtwc', normalizeJtwc],
    ['heat', '/api/heat-stress', normalizeHeat],
  ];
  const events = [];
  const status = {};
  await Promise.all(
    feeds.map(async ([name, path, normalize]) => {
      try {
        const snapshot = await getJson(`${baseUrl}${path}`, fetchImpl, timeoutMs, headers);
        const list = normalize(snapshot);
        events.push(...list);
        status[name] = { ok: true, stale: Boolean(snapshot.stale), count: list.length, fetchedAt: snapshot.fetchedAt ?? null };
      } catch (error) {
        status[name] = { ok: false, error: error.message, count: 0 };
      }
    }),
  );
  return { events, status };
}
