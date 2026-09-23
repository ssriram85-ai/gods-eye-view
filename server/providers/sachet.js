import { readResponseTextCapped } from './common/http.js';

/**
 * @module providers/sachet
 * @description NDMA SACHET — India's Common Alerting Protocol (CAP 1.2) feed.
 * IMD, CWC, INCOIS and every State Disaster Management Authority publish
 * public-domain alerts here, each with an area polygon. The proxy reads the
 * fixed national RSS index, fetches each CAP message once (an identifier is
 * immutable), attaches its polygon, and serves one bounded, normalized
 * snapshot. Nothing user-supplied ever reaches upstream.
 */

const ORIGIN = 'https://sachet.ndma.gov.in';
const RSS_URL = `${ORIGIN}/cap_public_website/rss/rss_india.xml`;
const CAP_URL = `${ORIGIN}/cap_public_website/FetchXMLFile?identifier=`;
const POLYGON_URL = `${ORIGIN}/cap_public_website/FetchPolygonXMLFile?identifier=`;
const COVERAGE =
  'India only: alerts issued through NDMA SACHET by IMD, CWC, INCOIS and State Disaster Management Authorities.';
const ATTRIBUTION =
  'NDMA SACHET (National Disaster Management Authority, Government of India) — CAP 1.2 alerts, public domain';

const HOUR = 3600_000;
/** Alerts kept per snapshot; the national feed carries ~100 on a busy evening. */
export const SACHET_MAX_ALERTS = 400;
/** Vertices kept per ring after decimation; SDMA mandal outlines run to thousands. */
export const SACHET_MAX_RING_POINTS = 240;
/** Rings kept per alert (multi-district alerts). */
export const SACHET_MAX_RINGS = 64;
const RSS_CAP = 2 * 1024 * 1024;
const CAP_CAP = 512 * 1024;
const POLYGON_CAP = 8 * 1024 * 1024;
const REFRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const STALE_LIMIT_MS = 6 * HOUR;
const CONCURRENCY = 2;
/** Consecutive polygon refusals after which a refresh stops asking; the next refresh retries. */
const POLYGON_REFUSAL_LIMIT = 3;

export const SACHET_SEVERITIES = Object.freeze([
  'Extreme',
  'Severe',
  'Moderate',
  'Minor',
  'Unknown',
]);
const URGENCIES = new Set([
  'Immediate',
  'Expected',
  'Future',
  'Past',
  'Unknown',
]);
const CERTAINTIES = new Set([
  'Observed',
  'Likely',
  'Possible',
  'Unlikely',
  'Unknown',
]);
const CATEGORIES = new Set([
  'Geo',
  'Met',
  'Safety',
  'Security',
  'Rescue',
  'Fire',
  'Health',
  'Env',
  'Transport',
  'Infra',
  'CBRNE',
  'Other',
]);

const ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/** Decode the five XML entities plus numeric references; nothing else is HTML. */
export function decodeXmlText(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, ref) => {
      const key = ref.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key];
      const code =
        key[1] === 'x'
          ? parseInt(key.slice(2), 16)
          : parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    });
}

function tag(xml, name) {
  const match = xml.match(
    new RegExp(
      `<(?:cap:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:cap:)?${name}>`,
    ),
  );
  return match ? decodeXmlText(match[1]).trim() : '';
}
function tags(xml, name) {
  return [
    ...xml.matchAll(
      new RegExp(
        `<(?:cap:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:cap:)?${name}>`,
        'g',
      ),
    ),
  ].map((match) => decodeXmlText(match[1]).trim());
}
function blocks(xml, name) {
  return [
    ...xml.matchAll(
      new RegExp(
        `<(?:cap:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:cap:)?${name}>`,
        'g',
      ),
    ),
  ].map((match) => match[1]);
}

/** Plain text, bounded, with control characters and markup stripped. */
function clean(value, max) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function enumerated(set, value, fallback = 'Unknown') {
  const text = clean(value, 32);
  return set.has(text) ? text : fallback;
}
/** CAP timestamps carry a numeric offset (+05:30); normalize to UTC ISO. */
function isoTime(value) {
  const text = clean(value, 40);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(text)
  )
    return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function identifier(value) {
  const text = clean(value, 64);
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : null;
}

/**
 * CAP polygons are "lat,lon lat,lon …" rings. Returns [lon, lat] rings that
 * are closed, decimated to a bounded vertex count, or null when unusable.
 */
export function parseCapPolygon(text, maxPoints = SACHET_MAX_RING_POINTS) {
  const pairs = String(text || '')
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number));
  const ring = [];
  for (const pair of pairs) {
    if (pair.length !== 2 || !pair.every(Number.isFinite)) return null;
    const [lat, lon] = pair;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    ring.push([lon, lat]);
  }
  if (ring.length < 3) return null;
  const first = ring[0],
    last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) ring.pop();
  if (ring.length < 3) return null;
  let kept = ring;
  if (ring.length > maxPoints) {
    const step = ring.length / maxPoints;
    kept = [];
    for (let i = 0; i < maxPoints; i++) kept.push(ring[Math.floor(i * step)]);
  }
  kept.push([kept[0][0], kept[0][1]]);
  return kept;
}

function centroidOf(rings) {
  let x = 0,
    y = 0,
    n = 0;
  for (const ring of rings)
    for (let i = 0; i < ring.length - 1; i++) {
      x += ring[i][0];
      y += ring[i][1];
      n++;
    }
  return n ? { longitude: x / n, latitude: y / n } : null;
}

/** Extract the ordered, de-duplicated CAP identifiers the RSS index links to. */
export function parseSachetIndex(rss) {
  const ids = [];
  const seen = new Set();
  for (const match of String(rss).matchAll(
    /FetchXMLFile\?identifier=(\d{1,32})/g,
  )) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    ids.push(match[1]);
    if (ids.length >= SACHET_MAX_ALERTS) break;
  }
  return ids;
}

/**
 * Normalize one CAP 1.2 message. English `info` is preferred; the first other
 * language block supplies a local-language headline (Tamil, Telugu, …).
 * Geometry comes from inline `<polygon>` elements, else from `polygonXml`
 * (the separate SACHET polygon document). Returns null when the message has
 * no usable identifier.
 */
export function parseCapAlert(feedId, capXml, polygonXml = null) {
  const cap = String(capXml);
  const id = identifier(tag(cap, 'identifier')) || identifier(feedId);
  if (!id) return null;
  const infos = blocks(cap, 'info');
  const english =
    infos.find((info) => /^en/i.test(tag(info, 'language'))) || infos[0] || '';
  const local = infos.find((info) => info !== english) || null;
  let rings = tags(english, 'polygon')
    .map((ring) => parseCapPolygon(ring))
    .filter(Boolean);
  if (!rings.length && polygonXml)
    rings = tags(String(polygonXml), 'polygon')
      .map((ring) => parseCapPolygon(ring))
      .filter(Boolean);
  rings = rings.slice(0, SACHET_MAX_RINGS);
  const centroid = centroidOf(rings);
  const localLanguage = local ? clean(tag(local, 'language'), 16) : '';
  return {
    id,
    feedId: identifier(feedId) || id,
    sender: clean(tag(cap, 'sender'), 80) || 'Unknown sender',
    sent: isoTime(tag(cap, 'sent')),
    status: clean(tag(cap, 'status'), 16) || 'Unknown',
    msgType: clean(tag(cap, 'msgType'), 16) || 'Alert',
    category: enumerated(CATEGORIES, tag(english, 'category'), 'Other'),
    event: clean(tag(english, 'event'), 80) || 'Alert',
    urgency: enumerated(URGENCIES, tag(english, 'urgency')),
    severity: enumerated(new Set(SACHET_SEVERITIES), tag(english, 'severity')),
    certainty: enumerated(CERTAINTIES, tag(english, 'certainty')),
    onset: isoTime(tag(english, 'onset')) || isoTime(tag(english, 'effective')),
    expires: isoTime(tag(english, 'expires')),
    headline: clean(tag(english, 'headline'), 400),
    description: clean(tag(english, 'description'), 800),
    instruction: clean(tag(english, 'instruction'), 800),
    areaDesc: clean(tag(english, 'areaDesc'), 160),
    localLanguage,
    localHeadline: local ? clean(tag(local, 'headline'), 400) : '',
    centroid,
    polygons: rings,
    capUrl: `${CAP_URL}${encodeURIComponent(identifier(feedId) || id)}`,
  };
}

/** Rank for sorting: most severe first, then most recent. */
export function severityRank(severity) {
  const index = SACHET_SEVERITIES.indexOf(severity);
  return index === -1 ? SACHET_SEVERITIES.length : index;
}

/**
 * Fixed official endpoints; one shared bounded refresh; per-identifier memo so
 * a steady feed costs one index request per refresh. No user destinations.
 */
export function sachetProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 45_000,
  refreshMs = REFRESH_MS,
} = {}) {
  let cache = null;
  let operation = null;
  let attemptedAt = -Infinity;
  /** identifier -> normalized alert (CAP messages never change once issued). */
  const memo = new Map();

  async function upstream(
    url,
    cap,
    signal,
    accept = 'application/xml,text/xml',
  ) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: accept,
        'User-Agent': 'Gods Eye View (public NDMA SACHET alert context)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error('sachet_upstream_unavailable'), {
        status: response.status,
      });
    }
    const text = await readResponseTextCapped(response, cap, signal);
    signal.throwIfAborted();
    return text;
  }

  async function acquirePolygon(feedId, signal, refusals) {
    if (refusals.count >= POLYGON_REFUSAL_LIMIT) return null;
    try {
      const xml = await upstream(
        `${POLYGON_URL}${feedId}`,
        POLYGON_CAP,
        signal,
      );
      refusals.count = 0;
      return xml;
    } catch (error) {
      if (signal.aborted) throw error;
      // The portal rate-limits this endpoint (403 bursts). An unmapped alert
      // stays listed; its polygon is asked for again on a later refresh.
      refusals.count++;
      return null;
    }
  }

  function remember(feedId, capXml, polygonXml) {
    const alert = parseCapAlert(feedId, capXml, polygonXml);
    if (!alert) return null;
    // Keep the immutable message so a refused polygon can be attached later
    // without re-fetching it. Internal fields are stripped before serving.
    alert.capXml = capXml;
    alert.polygonPending = !alert.polygons.length;
    memo.set(feedId, alert);
    return alert;
  }

  async function acquireAlert(feedId, signal, refusals) {
    const known = memo.get(feedId);
    if (known && !known.polygonPending) return known;
    if (known) {
      const polygonXml = await acquirePolygon(feedId, signal, refusals);
      return polygonXml ? remember(feedId, known.capXml, polygonXml) : known;
    }
    const capXml = await upstream(`${CAP_URL}${feedId}`, CAP_CAP, signal);
    const polygonXml = /<(?:cap:)?polygon>/.test(capXml)
      ? null
      : await acquirePolygon(feedId, signal, refusals);
    return remember(feedId, capXml, polygonXml);
  }

  async function refresh(signal) {
    const ids = parseSachetIndex(await upstream(RSS_URL, RSS_CAP, signal));
    const results = new Array(ids.length).fill(null);
    let failures = 0;
    const queue = ids.map((feedId, index) => ({ feedId, index }));
    const refusals = { count: 0 };
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length) {
          const { feedId, index } = queue.shift();
          try {
            results[index] = await acquireAlert(feedId, signal, refusals);
          } catch (error) {
            if (signal.aborted) throw error;
            failures++;
          }
        }
      }),
    );
    signal.throwIfAborted();
    // A refresh that could read the index but almost none of its messages is
    // an outage, not an empty India; keep the last good snapshot instead.
    if (ids.length && failures > ids.length / 2)
      throw new Error('sachet_messages_unavailable');
    const live = new Set(ids);
    for (const key of memo.keys()) if (!live.has(key)) memo.delete(key);
    const current = now();
    const seen = new Set();
    const alerts = results
      .filter((alert) => {
        // Two feed rows can carry one CAP identifier (an update re-listed);
        // the client contract requires unique ids.
        if (!alert || seen.has(alert.id)) return false;
        seen.add(alert.id);
        return (
          alert.expires === null || Date.parse(alert.expires) > current - HOUR
        );
      })
      .map(({ capXml, polygonPending, ...alert }) => alert)
      .sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          (b.sent || '').localeCompare(a.sent || ''),
      );
    cache = {
      alerts,
      unmapped: alerts.filter((alert) => !alert.centroid).length,
      indexed: ids.length,
      fetchedAt: current,
    };
    return cache;
  }

  async function acquire(signal) {
    signal.throwIfAborted();
    if (cache && now() - cache.fetchedAt < refreshMs) return cache;
    if (operation?.controller.signal.aborted) operation = null;
    if (!operation) {
      if (now() - attemptedAt < RETRY_MS) throw new Error('sachet_retry_later');
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
      throw Object.assign(new Error('sachet_busy'), { status: 429 });
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
      source: 'NDMA SACHET',
      attribution: ATTRIBUTION,
      coverage: COVERAGE,
      fetchedAt: value?.fetchedAt ?? null,
      stale: stale || !value,
      unavailable: !value,
      reason: !value
        ? 'SACHET alerts unavailable'
        : stale
          ? 'Cached SACHET alerts; upstream unavailable'
          : null,
      indexed: value?.indexed ?? 0,
      unmapped: value?.unmapped ?? 0,
      alerts: value?.alerts ?? [],
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
        return json(400, { error: 'invalid_sachet_query' });
      try {
        json(200, describe(await acquire(controller.signal)));
      } catch (error) {
        if (error.status === 429) return json(429, { error: 'sachet_busy' });
        const usable = cache && now() - cache.fetchedAt <= STALE_LIMIT_MS;
        json(200, describe(usable ? cache : null, true));
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'sachet',
    configureServer({ middlewares }) {
      middlewares.use('/api/sachet', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sachet', handler);
    },
  };
}
