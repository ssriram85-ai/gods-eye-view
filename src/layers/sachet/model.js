/**
 * @module sachet/model
 * @description Pure presentation rules for NDMA SACHET alerts: severity
 * colors, region filters and row text. No Cesium, no DOM.
 */

export const SACHET_LAYER_ID = 'sachet-alerts';
export const SACHET_SOURCE_LABEL = 'NDMA SACHET';

/** CAP severity accents. Unknown stays neutral so it never reads as "safe". */
export const SACHET_SEVERITY_COLORS = Object.freeze({
  Extreme: '#ff4d6d',
  Severe: '#ff9f43',
  Moderate: '#ffd93d',
  Minor: '#8be9fd',
  Unknown: '#b8c0cc',
});
export const SACHET_SELECTED_ACCENT = '#ffffff';
export const SACHET_SEVERITY_ORDER = Object.freeze([
  'Extreme',
  'Severe',
  'Moderate',
  'Minor',
  'Unknown',
]);

/**
 * Region presets. A match is by sender/area text or by centroid inside the
 * box, so an IMD regional centre alert still counts for its state.
 */
export const SACHET_REGIONS = Object.freeze({
  india: Object.freeze({
    id: 'india',
    label: 'ALL INDIA',
    box: null,
    terms: [],
  }),
  'tamil-nadu': Object.freeze({
    id: 'tamil-nadu',
    label: 'TAMIL NADU',
    box: Object.freeze({ west: 76.2, south: 8.0, east: 80.4, north: 13.6 }),
    terms: Object.freeze(['tamil', 'chennai', 'puducherry']),
  }),
});
export const SACHET_DEFAULT_REGION = 'india';
export const SACHET_DEFAULT_MIN_SEVERITY = 'Moderate';
/** Rows shown in the panel list; the map still draws every filtered alert. */
export const SACHET_LIST_LIMIT = 40;

export function severityColor(severity) {
  return SACHET_SEVERITY_COLORS[severity] || SACHET_SEVERITY_COLORS.Unknown;
}
export function severityRank(severity) {
  const index = SACHET_SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SACHET_SEVERITY_ORDER.length : index;
}
export function normalizeRegion(value) {
  return Object.hasOwn(SACHET_REGIONS, value) ? value : SACHET_DEFAULT_REGION;
}
export function normalizeMinSeverity(value) {
  return SACHET_SEVERITY_ORDER.includes(value)
    ? value
    : SACHET_DEFAULT_MIN_SEVERITY;
}

export function alertInRegion(alert, regionId) {
  const region = SACHET_REGIONS[normalizeRegion(regionId)];
  if (!region.box) return true;
  const haystack = `${alert.sender} ${alert.areaDesc}`.toLowerCase();
  if (region.terms.some((term) => haystack.includes(term))) return true;
  const c = alert.centroid;
  return Boolean(
    c &&
    c.longitude >= region.box.west &&
    c.longitude <= region.box.east &&
    c.latitude >= region.box.south &&
    c.latitude <= region.box.north,
  );
}

/** Alerts at or above the severity floor, inside the region, most severe first. */
export function filterAlerts(alerts, { region, minSeverity } = {}) {
  const floor = severityRank(normalizeMinSeverity(minSeverity));
  return alerts
    .filter(
      (alert) =>
        severityRank(alert.severity) <= floor && alertInRegion(alert, region),
    )
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        (b.sent || '').localeCompare(a.sent || ''),
    );
}

export function countBySeverity(alerts) {
  const counts = Object.fromEntries(SACHET_SEVERITY_ORDER.map((s) => [s, 0]));
  for (const alert of alerts)
    counts[alert.severity] = (counts[alert.severity] || 0) + 1;
  return counts;
}

/** "23 Sep 20:17 IST" — alerts are issued and read in India. */
export function istTime(iso) {
  if (!iso) return 'Unavailable';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'Unavailable';
  const shifted = new Date(ms + 5.5 * 3600_000);
  const month = shifted.toLocaleString('en', {
    month: 'short',
    timeZone: 'UTC',
  });
  const day = shifted.getUTCDate();
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${hh}:${mm} IST`;
}

/** Sender ids are slugs like "Andhra-Pradesh-SDMA" or "IMD-Chennai". */
export function senderName(sender) {
  return String(sender || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function alertRowText(alert) {
  const where = alert.areaDesc ? ` · ${alert.areaDesc}` : '';
  return `${alert.event} · ${senderName(alert.sender)}${where}`;
}

export function alertSummary(alert) {
  return [
    `${alert.severity} · ${alert.event} · ${alert.urgency} · ${alert.certainty}`,
    `Issued by ${senderName(alert.sender)} at ${istTime(alert.sent)}${alert.expires ? ` · expires ${istTime(alert.expires)}` : ''}`,
    alert.areaDesc ? `Area: ${alert.areaDesc}` : null,
    alert.headline || null,
    alert.instruction ? `Instruction: ${alert.instruction}` : null,
    alert.localHeadline || null,
    alert.polygons.length
      ? null
      : 'Area polygon not available yet: the portal rate-limits polygon downloads; it is retried on the next refresh.',
  ]
    .filter(Boolean)
    .join('\n');
}
