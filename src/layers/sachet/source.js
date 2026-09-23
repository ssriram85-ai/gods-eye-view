import { readResponseJsonCapped } from '../../sources/httpBody.js';

export const SACHET_RESPONSE_LIMIT = 12 * 1024 * 1024;
export const SACHET_SEVERITIES = Object.freeze([
  'Extreme',
  'Severe',
  'Moderate',
  'Minor',
  'Unknown',
]);
const MAX_ALERTS = 400;
const MAX_RINGS = 64;
const MAX_RING_POINTS = 260;
const MAX_COORDINATES = 400_000;

const malformed = () => new Error('Malformed SACHET snapshot');
const text = (value, max, { allowEmpty = false } = {}) => {
  if (typeof value !== 'string' || value.length > max) throw malformed();
  if (!allowEmpty && !value.trim()) throw malformed();
  if (/[\u0000-\u001f<>]/.test(value)) throw malformed();
  return value;
};
const enumerated = (values, value) => {
  if (!values.includes(value)) throw malformed();
  return value;
};
const time = (value) => {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw malformed();
  return value;
};
const number = (value, low, high) => {
  if (!Number.isFinite(value) || value < low || value > high) throw malformed();
  return value;
};
const position = (value) => {
  if (value === null) return null;
  return {
    longitude: number(value?.longitude, -180, 180),
    latitude: number(value?.latitude, -90, 90),
  };
};

function officialLink(value) {
  const url = new URL(text(value, 256));
  if (
    url.origin !== 'https://sachet.ndma.gov.in' ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/cap_public_website/FetchXMLFile' ||
    !/^\?identifier=[A-Za-z0-9_.%:-]{1,80}$/.test(url.search)
  )
    throw malformed();
  return url.href;
}

function rings(value, budget) {
  if (!Array.isArray(value) || value.length > MAX_RINGS) throw malformed();
  return value.map((ring) => {
    if (
      !Array.isArray(ring) ||
      ring.length < 4 ||
      ring.length > MAX_RING_POINTS + 1
    )
      throw malformed();
    const result = ring.map((pair) => {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair.some((n) => typeof n !== 'number')
      )
        throw malformed();
      number(pair[0], -180, 180);
      number(pair[1], -90, 90);
      if (++budget.coordinates > MAX_COORDINATES) throw malformed();
      return [pair[0], pair[1]];
    });
    if (result[0][0] !== result.at(-1)[0] || result[0][1] !== result.at(-1)[1])
      throw malformed();
    return result;
  });
}

/** Project only the bounded alert contract; never ingest arbitrary properties or URLs. */
export function validateSachetSnapshot(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.stale !== 'boolean' ||
    typeof value.unavailable !== 'boolean' ||
    !Array.isArray(value.alerts) ||
    value.alerts.length > MAX_ALERTS
  )
    throw malformed();
  const seen = new Set();
  const budget = { coordinates: 0 };
  const alerts = value.alerts.map((raw) => {
    const id = text(raw?.id, 64);
    if (!/^[A-Za-z0-9_.:-]+$/.test(id) || seen.has(id)) throw malformed();
    seen.add(id);
    const polygons = rings(raw.polygons, budget);
    const centroid = position(raw.centroid);
    if ((centroid === null) !== (polygons.length === 0)) throw malformed();
    return {
      id,
      sender: text(raw.sender, 80),
      sent: time(raw.sent),
      status: text(raw.status, 16),
      msgType: text(raw.msgType, 16),
      category: text(raw.category, 16),
      event: text(raw.event, 80),
      urgency: text(raw.urgency, 16),
      severity: enumerated(SACHET_SEVERITIES, raw.severity),
      certainty: text(raw.certainty, 16),
      onset: time(raw.onset),
      expires: time(raw.expires),
      headline: text(raw.headline, 400, { allowEmpty: true }),
      description: text(raw.description, 800, { allowEmpty: true }),
      instruction: text(raw.instruction, 800, { allowEmpty: true }),
      areaDesc: text(raw.areaDesc, 160, { allowEmpty: true }),
      localLanguage: text(raw.localLanguage, 16, { allowEmpty: true }),
      localHeadline: text(raw.localHeadline, 400, { allowEmpty: true }),
      centroid,
      polygons,
      capUrl: officialLink(raw.capUrl),
    };
  });
  if (value.unavailable && alerts.length) throw malformed();
  return {
    schemaVersion: 1,
    source: text(value.source, 80),
    attribution: text(value.attribution, 240),
    coverage: text(value.coverage, 240),
    fetchedAt:
      value.fetchedAt === null
        ? null
        : number(value.fetchedAt, 0, Number.MAX_SAFE_INTEGER),
    stale: value.stale,
    unavailable: value.unavailable,
    reason: value.reason === null ? null : text(value.reason, 240),
    indexed: number(value.indexed ?? 0, 0, 10_000),
    unmapped: number(value.unmapped ?? 0, 0, 10_000),
    alerts,
  };
}

/** Lazy same-origin acquisition; the source owns only its deadline and cancellation. */
export function createSachetSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 60_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('SACHET request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/sachet', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`SACHET HTTP ${response.status}`);
        }
        const result = await readResponseJsonCapped(
          response,
          SACHET_RESPONSE_LIMIT,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return validateSachetSnapshot(result);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
