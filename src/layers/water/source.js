import {
  OVERPASS_URL,
  MAX_VIEWPORT_DEGREES,
  QUERY_SNAP_DEGREES,
  QUERY_LIMIT,
  buildWaterQuery,
  normalizeElement,
} from './model.js';

/** Bounded OpenStreetMap water-hazard request through the shared Overpass proxy. */
export function createWaterHazardSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function fetchRecords(box, signal) {
    signal?.throwIfAborted();
    if (
      !box ||
      ![box.south, box.west, box.north, box.east].every(Number.isFinite) ||
      box.south < -90 ||
      box.north > 90 ||
      box.west < -180 ||
      box.east > 180 ||
      box.north <= box.south ||
      box.east <= box.west ||
      box.north - box.south >
        MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 ||
      box.east - box.west > MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
    )
      throw new TypeError('Water hazards require a bounded city viewport');
    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(buildWaterQuery(box))}`,
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      throw new Error(
        response.status === 429
          ? 'Overpass rate-limited'
          : response.status === 504
            ? 'Overpass timed out'
            : `Overpass mirrors refused the query (HTTP ${response.status})`,
      );
    }
    const stale = response.headers.get('x-overpass-cache') === 'STALE';
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.elements) || payload.remark)
      throw new Error('Overpass returned an incomplete water response');
    const records = [
      ...new Map(
        payload.elements
          .slice(0, QUERY_LIMIT)
          .map(normalizeElement)
          .filter(Boolean)
          .map((record) => [record.id, record]),
      ).values(),
    ];
    return {
      records,
      stale,
      saturated: payload.elements.length >= QUERY_LIMIT,
    };
  }
  return { fetch: fetchRecords };
}
