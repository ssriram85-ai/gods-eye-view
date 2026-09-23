import { readResponseJsonCapped } from '../../sources/httpBody.js';

export const HEAT_RESPONSE_LIMIT = 2 * 1024 * 1024;
const MAX_SAMPLES = 400;
const malformed = () => new Error('Malformed heat stress snapshot');
const text = (value, max) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f<>]/.test(value)
  )
    throw malformed();
  return value;
};
const number = (value, low, high) => {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < low || value > high) throw malformed();
  return value;
};
const required = (value, low, high) => {
  const n = number(value, low, high);
  if (n === null) throw malformed();
  return n;
};
const time = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw malformed();
  return value;
};

/** Project only the bounded sample contract; never ingest arbitrary properties. */
export function validateHeatStressSnapshot(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.stale !== 'boolean' ||
    typeof value.unavailable !== 'boolean' ||
    !Array.isArray(value.samples) ||
    value.samples.length > MAX_SAMPLES
  )
    throw malformed();
  const seen = new Set();
  const samples = value.samples.map((raw) => {
    const id = text(raw?.id, 64);
    if (!/^[a-z0-9-]+$/.test(id) || seen.has(id)) throw malformed();
    seen.add(id);
    if (
      typeof raw.coastal !== 'boolean' ||
      typeof raw.imdThresholdMet !== 'boolean'
    )
      throw malformed();
    return {
      id,
      name: text(raw.name, 60),
      region: text(raw.region, 8),
      coastal: raw.coastal,
      position: {
        longitude: required(raw.position?.longitude, -180, 180),
        latitude: required(raw.position?.latitude, -90, 90),
      },
      observedAt: time(raw.observedAt),
      feelsLikeC: required(raw.feelsLikeC, -60, 70),
      airC: number(raw.airC, -60, 70),
      humidityPct: number(raw.humidityPct, 0, 100),
      windKmh: number(raw.windKmh, 0, 300),
      feelsLikeMaxTodayC: number(raw.feelsLikeMaxTodayC, -60, 70),
      feelsLikeMaxTomorrowC: number(raw.feelsLikeMaxTomorrowC, -60, 70),
      airMaxTodayC: number(raw.airMaxTodayC, -60, 70),
      imdThresholdC: required(raw.imdThresholdC, 30, 50),
      imdThresholdMet: raw.imdThresholdMet,
    };
  });
  if (value.unavailable && samples.length) throw malformed();
  return {
    schemaVersion: 1,
    source: text(value.source, 80),
    attribution: text(value.attribution, 240),
    coverage: text(value.coverage, 240),
    fetchedAt:
      value.fetchedAt === null
        ? null
        : required(value.fetchedAt, 0, Number.MAX_SAFE_INTEGER),
    stale: value.stale,
    unavailable: value.unavailable,
    reason: value.reason === null ? null : text(value.reason, 240),
    dropped: required(value.dropped ?? 0, 0, 10_000),
    samples,
  };
}

/** Lazy same-origin acquisition of /api/heat-stress. */
export function createHeatStressSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 25_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Heat stress request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/heat-stress', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Heat stress HTTP ${response.status}`);
        }
        const result = await readResponseJsonCapped(
          response,
          HEAT_RESPONSE_LIMIT,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return validateHeatStressSnapshot(result);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
