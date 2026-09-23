/**
 * @module water/model
 * @description Presentation rules for the water hazard layer: OSM feature
 * categories, viewport snapping and reuse, and row text. No Cesium, no DOM.
 */

export const WATER_LAYER_ID = 'water-hazards';
export const WATER_SOURCE_LABEL = 'OpenStreetMap';
export const OVERPASS_URL = '/api/overpass';
/** Keep public Overpass queries city-scale, never region-wide. */
export const MAX_VIEWPORT_DEGREES = 1.5;
export const QUERY_SNAP_DEGREES = 0.05;
export const QUERY_REUSE_MS = 10 * 60_000;
export const QUERY_LIMIT = 1200;
export const REQUEST_DEBOUNCE_MS = 600;
export const WATER_LIST_LIMIT = 40;
export const WATER_SELECTED_ACCENT = '#ffffff';

/** Categories in the order the list and legend present them. */
export const WATER_CATEGORIES = Object.freeze({
  quarry: Object.freeze({
    id: 'quarry',
    label: 'Quarry',
    chip: 'QUARRIES',
    color: '#ff4d6d',
    blurb: 'Quarry pits, often flooded and unfenced',
  }),
  tank: Object.freeze({
    id: 'tank',
    label: 'Tank / lake / pond',
    chip: 'TANKS & LAKES',
    color: '#52a7ff',
    blurb: 'Irrigation tanks (eri), lakes and ponds',
  }),
  reservoir: Object.freeze({
    id: 'reservoir',
    label: 'Reservoir',
    chip: 'RESERVOIRS',
    color: '#8be9fd',
    blurb: 'Dam reservoirs with sudden depth changes and releases',
  }),
  beach: Object.freeze({
    id: 'beach',
    label: 'Beach',
    chip: 'BEACHES',
    color: '#ffd93d',
    blurb: 'Surf beaches; rip currents and swell',
  }),
});
export const WATER_CATEGORY_ORDER = Object.freeze(
  Object.keys(WATER_CATEGORIES),
);
export const WATER_DEFAULT_FILTER = 'all';

export function normalizeFilter(value) {
  return value === 'all' || Object.hasOwn(WATER_CATEGORIES, value)
    ? value
    : WATER_DEFAULT_FILTER;
}
export function categoryColor(category) {
  return WATER_CATEGORIES[category]?.color || '#b8c0cc';
}

/** Overpass QL for one bounded box: quarries, standing water and beaches. */
export function buildWaterQuery(box) {
  const b = `(${box.south},${box.west},${box.north},${box.east})`;
  return (
    `[out:json][timeout:25];(` +
    `nwr["landuse"="quarry"]${b};` +
    `nwr["natural"="water"]["water"!~"^(river|canal|stream|ditch|drain|moat|wastewater|lock)$"]${b};` +
    `nwr["natural"="beach"]${b};` +
    `);out tags center ${QUERY_LIMIT};`
  );
}

/** Category for one OSM element's tags, or null when it is not a hazard class. */
export function categorize(tags = {}) {
  if (tags.landuse === 'quarry') return 'quarry';
  if (tags.natural === 'beach') return 'beach';
  if (tags.natural === 'water') {
    if (tags.water === 'reservoir') return 'reservoir';
    if (tags.landuse === 'reservoir') return 'reservoir';
    return 'tank';
  }
  return null;
}

/** Plain-text OSM name, bounded and markup-free. */
export function cleanName(tags = {}) {
  const raw = tags['name:en'] || tags.name || tags['name:ta'] || '';
  return String(raw)
    .replace(/[\u0000-\u001f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** One record from an Overpass `out tags center` element, or null. */
export function normalizeElement(element) {
  const category = categorize(element?.tags);
  if (!category) return null;
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    !['node', 'way', 'relation'].includes(element.type) ||
    !Number.isInteger(element.id) ||
    element.id <= 0
  )
    return null;
  const tags = element.tags || {};
  return {
    id: `${element.type}/${element.id}`,
    category,
    name: cleanName(tags),
    latitude: lat,
    longitude: lon,
    water: typeof tags.water === 'string' ? tags.water.slice(0, 32) : '',
    disused:
      tags.disused === 'yes' ||
      tags.abandoned === 'yes' ||
      'disused:landuse' in tags,
    osmUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
  };
}

/** Snap a box outward to the query grid so nearby views share one request. */
export function snapBox(box, step = QUERY_SNAP_DEGREES) {
  // Round to the grid's own precision so 13.2 never becomes 13.200000000000001.
  const grid = (v) => Number(v.toFixed(6));
  const down = (v) => grid(Math.floor(v / step + 1e-9) * step);
  const up = (v) => grid(Math.ceil(v / step - 1e-9) * step);
  return {
    south: Math.max(-90, down(box.south)),
    west: Math.max(-180, down(box.west)),
    north: Math.min(90, up(box.north)),
    east: Math.min(180, up(box.east)),
  };
}
export function boxContains(outer, inner) {
  return (
    !!outer &&
    !!inner &&
    inner.south >= outer.south &&
    inner.north <= outer.north &&
    inner.west >= outer.west &&
    inner.east <= outer.east
  );
}
export function boxSpanDegrees(box) {
  return Math.max(box.north - box.south, box.east - box.west);
}

export function filterRecords(records, filter) {
  const wanted = normalizeFilter(filter);
  const kept =
    wanted === 'all' ? records : records.filter((r) => r.category === wanted);
  return [...kept].sort(
    (a, b) =>
      WATER_CATEGORY_ORDER.indexOf(a.category) -
        WATER_CATEGORY_ORDER.indexOf(b.category) ||
      (b.name ? 1 : 0) - (a.name ? 1 : 0) ||
      a.name.localeCompare(b.name),
  );
}
export function countByCategory(records) {
  const counts = Object.fromEntries(WATER_CATEGORY_ORDER.map((c) => [c, 0]));
  for (const record of records) counts[record.category]++;
  return counts;
}

export function recordRowText(record) {
  const label = WATER_CATEGORIES[record.category].label;
  return `${record.name || `Unnamed ${label.toLowerCase()}`}${record.disused ? ' · disused' : ''}`;
}
export function recordSummary(record) {
  const category = WATER_CATEGORIES[record.category];
  return [
    `${record.name || `Unnamed ${category.label.toLowerCase()}`} · ${category.label}${record.water ? ` (${record.water})` : ''}${record.disused ? ' · disused' : ''}`,
    category.blurb,
    `${record.latitude.toFixed(4)}, ${record.longitude.toFixed(4)} · OpenStreetMap ${record.id}`,
  ].join('\n');
}
