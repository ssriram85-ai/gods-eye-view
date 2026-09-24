/**
 * Geocoding for products that only know a site's city or address, backed
 * by TomTom's Search API (the service already holds a TomTom key). Results
 * are cached on disk so a city is looked up once, not once per sync.
 */
const SEARCH = 'https://api.tomtom.com/search/2/geocode';
const MAX_QUERY = 200;

export function createGeocoder({ key, store, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map(Object.entries(store?.read('geocode', {}) || {}));
  const persist = () => store?.write('geocode', Object.fromEntries(cache));

  /** {latitude, longitude, label} for a free-text place, or null when nothing matched. */
  async function geocode(query, { country = 'IN' } = {}) {
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
    const cc = String(country || '').toUpperCase().replace(/[^A-Z,]/g, '').slice(0, 20);
    if (!q) throw new Error('query is required');
    if (!key) throw new Error('TOMTOM_API_KEY is not set');
    const cacheKey = `${cc}|${q.toLowerCase()}`;
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.at < 90 * 86_400_000) return hit.result;
    const params = new URLSearchParams({ limit: '1', key, ...(cc ? { countrySet: cc } : {}) });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let result = null;
    try {
      const r = await fetchImpl(`${SEARCH}/${encodeURIComponent(q)}.json?${params}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`TomTom geocode HTTP ${r.status}`);
      const top = (await r.json())?.results?.[0];
      const lat = Number(top?.position?.lat), lon = Number(top?.position?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const a = top.address || {};
        result = { latitude: lat, longitude: lon, label: [a.municipality, a.countrySubdivision, a.countryCode].filter(Boolean).join(', ') };
      }
    } finally {
      clearTimeout(timer);
    }
    cache.set(cacheKey, { at: now(), result });
    persist();
    return result;
  }

  return { geocode };
}
