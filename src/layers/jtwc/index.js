import { createCyclonesLayer } from '../cyclones/index.js';
export { createJtwcSource, validateJtwcSnapshot } from './source.js';

export const JTWC_LAYER_ID = 'weather-cyclones-jtwc';
const COVERAGE =
  'JTWC basins only: Northwest Pacific, North Indian Ocean (Bay of Bengal, Arabian Sea) and the Southern Hemisphere; not Atlantic or eastern/central Pacific coverage.';

/** JTWC wording: warnings, not advisories; a 34-knot danger swath, not an uncertainty cone. */
export const JTWC_CYCLONE_PROFILE = Object.freeze({
  id: JTWC_LAYER_ID,
  overlaySourceId: JTWC_LAYER_ID,
  name: 'Cyclone warnings · Indian Ocean & Pacific',
  source: 'JTWC',
  coverage: COVERAGE,
  summaryLabel: 'Cyclones · JTWC',
  coverageLabel: 'NW Pacific · N Indian Ocean · S Hemisphere',
  listAriaLabel: 'Active JTWC tropical cyclone warnings',
  emptyText: 'No active JTWC warnings',
  advisoryNoun: 'Warning',
  advisoryAction: 'Official warning ↗',
  geometryCurrent: 'Track and 34-kt danger swath match this warning',
  geometryPending: (warning) => `Track/swath awaiting warning ${warning}`,
  geometryUnavailable: 'Track/swath unavailable',
  legendTrack: 'Warning center / forecast track',
  legendCone: '34-knot wind danger swath',
  infoTitle:
    'Select a storm on the map, or choose a storm in the list to select it and move the camera. Click empty map space to clear the selection. JTWC warning context for the Northwest Pacific, North Indian Ocean and Southern Hemisphere. The shaded area is JTWC’s 34-knot danger swath: where gale-force winds may occur along the forecast track, not a center-track uncertainty cone. Forecast point labels are source lead hours. Winds are one-minute averages. IMD is the official warning authority for India; consult its bulletins alongside this.',
});

/** JTWC warnings drawn by the shared cyclone renderer under their own ids and wording. */
export function createJtwcLayer(options = {}) {
  return createCyclonesLayer({ ...options, profile: JTWC_CYCLONE_PROFILE });
}
