/** Small, dependency-free geometry: distances and point-in-polygon on [lon, lat]. */
const R_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Ray casting on a closed or open ring of [lon, lat] pairs. */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Inside any exterior ring of a polygon/multipolygon given as a list of rings. */
export function pointInPolygon(lon, lat, rings) {
  return rings.some((ring) => ring.length >= 3 && pointInRing(lon, lat, ring));
}

/**
 * Shortest distance (km) from a point to a polyline of [lon, lat] points,
 * using a local equirectangular projection per segment; fine at storm scale.
 */
export function distanceToLineKm(lon, lat, points) {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [lon1, lat1] = points[i];
    if (points.length === 1) return haversineKm(lat, lon, lat1, lon1);
    if (i === points.length - 1) break;
    const [lon2, lat2] = points[i + 1];
    const kx = Math.cos(rad((lat1 + lat2) / 2)) * 111.32;
    const ky = 110.574;
    const ax = (lon1 - lon) * kx, ay = (lat1 - lat) * ky;
    const bx = (lon2 - lon) * kx, by = (lat2 - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    best = Math.min(best, Math.hypot(px, py));
  }
  return best;
}
