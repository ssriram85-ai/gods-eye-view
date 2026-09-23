/**
 * @module heat/model
 * @description Presentation rules for the heat stress layer: NOAA heat-index
 * bands applied to Open-Meteo's apparent ("feels-like") temperature, the
 * now / today / tomorrow modes, and row text. No Cesium, no DOM.
 */

export const HEAT_LAYER_ID = 'heat-stress';
export const HEAT_SOURCE_LABEL = 'Open-Meteo';

/** Heat-index bands (NOAA), by feels-like °C. Order is coolest to hottest. */
export const HEAT_BANDS = Object.freeze([
  Object.freeze({
    id: 'normal',
    label: 'Below 27°',
    minC: -Infinity,
    color: '#8fb3c9',
  }),
  Object.freeze({
    id: 'caution',
    label: 'Caution 27–32°',
    minC: 27,
    color: '#ffd93d',
  }),
  Object.freeze({
    id: 'extreme-caution',
    label: 'Extreme caution 32–41°',
    minC: 32,
    color: '#ff9f43',
  }),
  Object.freeze({
    id: 'danger',
    label: 'Danger 41–54°',
    minC: 41,
    color: '#ff4d6d',
  }),
  Object.freeze({
    id: 'extreme-danger',
    label: 'Extreme danger 54°+',
    minC: 54,
    color: '#d64bff',
  }),
]);
export const HEAT_SELECTED_ACCENT = '#ffffff';
export const HEAT_MODES = Object.freeze({
  now: Object.freeze({ id: 'now', label: 'NOW', field: 'feelsLikeC' }),
  today: Object.freeze({
    id: 'today',
    label: 'TODAY MAX',
    field: 'feelsLikeMaxTodayC',
  }),
  tomorrow: Object.freeze({
    id: 'tomorrow',
    label: 'TOMORROW MAX',
    field: 'feelsLikeMaxTomorrowC',
  }),
});
export const HEAT_DEFAULT_MODE = 'now';
export const HEAT_LIST_LIMIT = 40;

export function normalizeMode(value) {
  return Object.hasOwn(HEAT_MODES, value) ? value : HEAT_DEFAULT_MODE;
}
/** The feels-like value a sample shows in a mode; null when the forecast lacks it. */
export function sampleValue(sample, mode) {
  const value = sample[HEAT_MODES[normalizeMode(mode)].field];
  return Number.isFinite(value) ? value : null;
}
export function bandFor(valueC) {
  if (!Number.isFinite(valueC)) return HEAT_BANDS[0];
  let band = HEAT_BANDS[0];
  for (const candidate of HEAT_BANDS)
    if (valueC >= candidate.minC) band = candidate;
  return band;
}
export function bandColor(valueC) {
  return bandFor(valueC).color;
}

/** Samples with a value in this mode, hottest first. */
export function rankSamples(samples, mode) {
  return samples
    .map((sample) => ({ sample, value: sampleValue(sample, mode) }))
    .filter(({ value }) => value !== null)
    .sort((a, b) => b.value - a.value)
    .map(({ sample }) => sample);
}

export function countByBand(samples, mode) {
  const counts = Object.fromEntries(HEAT_BANDS.map((band) => [band.id, 0]));
  for (const sample of samples) {
    const value = sampleValue(sample, mode);
    if (value !== null) counts[bandFor(value).id]++;
  }
  return counts;
}

export const degrees = (value) =>
  Number.isFinite(value) ? `${Math.round(value)}°` : '—';

export function istTime(iso) {
  if (!iso) return 'Unavailable';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'Unavailable';
  const shifted = new Date(ms + 5.5 * 3600_000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} IST`;
}

export function sampleRowText(sample, mode) {
  const value = sampleValue(sample, mode);
  const flag = sample.imdThresholdMet ? ' · IMD threshold' : '';
  return `${sample.name} · feels like ${degrees(value)}${flag}`;
}

export function sampleSummary(sample) {
  const now = bandFor(sample.feelsLikeC);
  return [
    `${sample.name}, ${sample.region} · feels like ${degrees(sample.feelsLikeC)} · ${now.label}`,
    `Air ${degrees(sample.airC)} · humidity ${sample.humidityPct === null ? '—' : `${Math.round(sample.humidityPct)}%`} · wind ${sample.windKmh === null ? '—' : `${Math.round(sample.windKmh)} km/h`} · observed ${istTime(sample.observedAt)}`,
    `Feels-like maximum: today ${degrees(sample.feelsLikeMaxTodayC)} · tomorrow ${degrees(sample.feelsLikeMaxTomorrowC)}`,
    sample.imdThresholdMet
      ? `Today's forecast air maximum ${degrees(sample.airMaxTodayC)} reaches IMD's ${sample.coastal ? 'coastal' : 'plains'} heat-wave temperature threshold (${sample.imdThresholdC}°). A declared heat wave also needs the departure from normal, which this layer does not compute.`
      : `Today's forecast air maximum ${degrees(sample.airMaxTodayC)} is below IMD's ${sample.coastal ? 'coastal' : 'plains'} heat-wave threshold (${sample.imdThresholdC}°).`,
  ].join('\n');
}
