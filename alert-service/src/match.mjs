import { haversineKm, pointInPolygon, distanceToLineKm } from './geo.mjs';
import { severityRank } from './feeds.mjs';

export const DEFAULT_THRESHOLDS = Object.freeze({ min_severity: 'warning', heat_feels_like_c: 41 });

/** Why an event applies to an asset, or null. */
export function matchOne(event, asset) {
  const g = event.geometry;
  const { latitude: lat, longitude: lon } = asset;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(asset.thresholds || {}) };
  if (severityRank(event.severity) < severityRank(thresholds.min_severity)) return null;
  if (event.expires && Date.parse(event.expires) < Date.now()) return null;
  if (event.source === 'heat' && (event.value?.peakC ?? -Infinity) < thresholds.heat_feels_like_c) return null;
  const reach = asset.radius_km || 0;
  if (g.type === 'polygon') {
    if (pointInPolygon(lon, lat, g.rings)) return 'inside the warning area';
    if (reach > 0) {
      const near = g.rings.some((ring) => ring.some(([x, y]) => haversineKm(lat, lon, y, x) <= reach));
      if (near) return `within ${reach} km of the warning area`;
    }
    return null;
  }
  if (g.type === 'line') {
    const d = distanceToLineKm(lon, lat, g.points);
    return d <= g.radiusKm + reach ? `${Math.round(d)} km from the forecast track` : null;
  }
  if (g.type === 'point') {
    const d = haversineKm(lat, lon, g.lat, g.lon);
    return d <= g.radiusKm + reach ? `${Math.round(d)} km from the nearest sampled city` : null;
  }
  return null;
}

/** Every (asset, event) pair that applies right now. */
export function matchAll(events, assets) {
  const matches = [];
  for (const asset of assets) {
    if (!Number.isFinite(asset.latitude) || !Number.isFinite(asset.longitude)) continue;
    for (const event of events) {
      const reason = matchOne(event, asset);
      if (reason) matches.push({ assetKey: asset.key, eventId: event.id, severity: event.severity, reason, event, asset });
    }
  }
  return matches;
}
