import { readResponseTextCapped } from './common/http.js';
import { HEAT_STRESS_POINTS } from './heat-stress/catalog.js';

/**
 * @module providers/heat-stress
 * @description Feels-like temperature for a fixed catalog of Indian cities,
 * from Open-Meteo in one multi-point request. Serves current apparent
 * temperature, air temperature, humidity and wind, plus today's and
 * tomorrow's forecast maxima, so the layer can show what the heat feels
 * like now and what is coming. Nothing user-supplied reaches upstream.
 */

const API = 'https://api.open-meteo.com/v1/forecast';
const CAP = 2 * 1024 * 1024;
const REFRESH_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const STALE_LIMIT_MS = 3 * 3600_000;
const HOUR = 3600_000;
const COVERAGE =
  'Fixed catalog of Indian state capitals, large cities and Tamil Nadu towns; point samples, not a continuous field.';
const ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';

/** IMD heat-wave temperature thresholds (°C): coast 37, plains 40. Departure from normal is not computed here. */
export const IMD_THRESHOLD_C = Object.freeze({ coastal: 37, plains: 40 });

function number(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * Normalize Open-Meteo's multi-location array into catalog-keyed samples.
 * A location that fails to parse is dropped; the snapshot reports how many.
 */
export function parseHeatStress(payload, points = HEAT_STRESS_POINTS) {
  const rows = Array.isArray(payload) ? payload : [payload];
  if (rows.length !== points.length) throw new Error('heat_stress_mismatch');
  const samples = [];
  let dropped = 0;
  rows.forEach((row, index) => {
    const point = points[index];
    const current = row?.current;
    const daily = row?.daily;
    const feelsLike = number(current?.apparent_temperature, -60, 70);
    // Open-Meteo answers in the requested zone (UTC) without a zone suffix.
    const stamp =
      typeof current?.time === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(current.time)
        ? `${current.time}Z`
        : current?.time;
    const observedAt =
      typeof stamp === 'string' && Number.isFinite(Date.parse(stamp))
        ? new Date(Date.parse(stamp)).toISOString()
        : null;
    if (feelsLike === null || !observedAt) {
      dropped++;
      return;
    }
    const maxToday = number(daily?.apparent_temperature_max?.[0], -60, 70);
    const maxTomorrow = number(daily?.apparent_temperature_max?.[1], -60, 70);
    const airMaxToday = number(daily?.temperature_2m_max?.[0], -60, 70);
    const threshold = point.coastal
      ? IMD_THRESHOLD_C.coastal
      : IMD_THRESHOLD_C.plains;
    samples.push({
      id: point.id,
      name: point.name,
      region: point.region,
      coastal: point.coastal,
      position: { longitude: point.longitude, latitude: point.latitude },
      observedAt,
      feelsLikeC: feelsLike,
      airC: number(current?.temperature_2m, -60, 70),
      humidityPct: number(current?.relative_humidity_2m, 0, 100),
      windKmh: number(current?.wind_speed_10m, 0, 300),
      feelsLikeMaxTodayC: maxToday,
      feelsLikeMaxTomorrowC: maxTomorrow,
      airMaxTodayC: airMaxToday,
      imdThresholdC: threshold,
      imdThresholdMet: airMaxToday !== null && airMaxToday >= threshold,
    });
  });
  return { samples, dropped };
}

/** Fixed catalog, one bounded upstream request per refresh; no user destinations. */
export function heatStressProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 20_000,
  points = HEAT_STRESS_POINTS,
} = {}) {
  let cache = null;
  let operation = null;
  let attemptedAt = -Infinity;

  async function refresh(signal) {
    const params = new URLSearchParams({
      latitude: points.map((p) => p.latitude.toFixed(4)).join(','),
      longitude: points.map((p) => p.longitude.toFixed(4)).join(','),
      current:
        'temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m',
      daily: 'apparent_temperature_max,temperature_2m_max',
      forecast_days: '2',
      timezone: 'UTC',
    });
    signal.throwIfAborted();
    const response = await fetchImpl(`${API}?${params}`, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Gods Eye View (public heat stress context)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('heat_stress_upstream_unavailable');
    }
    const parsed = parseHeatStress(
      JSON.parse(await readResponseTextCapped(response, CAP, signal)),
      points,
    );
    signal.throwIfAborted();
    if (!parsed.samples.length) throw new Error('heat_stress_empty');
    cache = { ...parsed, fetchedAt: now() };
    return cache;
  }

  async function acquire(signal) {
    signal.throwIfAborted();
    if (cache && now() - cache.fetchedAt < REFRESH_MS) return cache;
    if (operation?.controller.signal.aborted) operation = null;
    if (!operation) {
      if (now() - attemptedAt < RETRY_MS)
        throw new Error('heat_stress_retry_later');
      attemptedAt = now();
      const controller = new AbortController();
      const owned = { controller, waiters: 0 };
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      owned.promise = refresh(controller.signal).finally(() => {
        clearTimeout(timer);
        if (operation === owned) operation = null;
      });
      operation = owned;
    }
    const owned = operation;
    if (owned.waiters >= 32)
      throw Object.assign(new Error('heat_stress_busy'), { status: 429 });
    owned.waiters++;
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([owned.promise, cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
      if (--owned.waiters === 0 && operation === owned) {
        owned.controller.abort();
        if (signal.aborted) attemptedAt = -Infinity;
      }
    }
  }

  function describe(value, stale = false) {
    return {
      schemaVersion: 1,
      source: 'Open-Meteo',
      attribution: ATTRIBUTION,
      coverage: COVERAGE,
      fetchedAt: value?.fetchedAt ?? null,
      stale: stale || !value,
      unavailable: !value,
      reason: !value
        ? 'Heat stress data unavailable'
        : stale
          ? 'Cached heat stress data; upstream unavailable'
          : null,
      dropped: value?.dropped ?? 0,
      samples: value?.samples ?? [],
    };
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 429 ? { 'Retry-After': '2' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      if (req.url !== '/' && req.url !== '')
        return json(400, { error: 'invalid_heat_stress_query' });
      try {
        json(200, describe(await acquire(controller.signal)));
      } catch (error) {
        if (error.status === 429)
          return json(429, { error: 'heat_stress_busy' });
        const usable = cache && now() - cache.fetchedAt <= STALE_LIMIT_MS;
        json(200, describe(usable ? cache : null, true));
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'heat-stress',
    configureServer({ middlewares }) {
      middlewares.use('/api/heat-stress', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/heat-stress', handler);
    },
  };
}

export { HOUR as HEAT_STRESS_HOUR_MS };
