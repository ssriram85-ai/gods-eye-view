import { inflateRawSync } from 'node:zlib';
import {
  readResponseTextCapped,
  readResponseBytesCapped,
} from './common/http.js';

/**
 * @module providers/jtwc
 * @description Joint Typhoon Warning Center tropical cyclone warnings for the
 * basins NOAA's NHC does not cover: the Northwest Pacific, the North Indian
 * Ocean (Bay of Bengal, Arabian Sea) and the Southern Hemisphere. The proxy
 * reads JTWC's fixed RSS index, then each storm's JMV 3.0 data file (one
 * line per forecast hour) and its KMZ overlay (forecast track and the
 * official 34-knot danger swath), and serves storms in the same shape the
 * NHC cyclone layer already renders. Nothing user-supplied reaches upstream.
 */

const ORIGIN = 'https://www.metoc.navy.mil';
const RSS_URL = `${ORIGIN}/jtwc/rss/jtwc.rss`;
const PRODUCTS = `${ORIGIN}/jtwc/products/`;
const HOME_URL = `${ORIGIN}/jtwc/jtwc.html`;
const COVERAGE =
  'JTWC basins only: Northwest Pacific, North Indian Ocean (Bay of Bengal, Arabian Sea) and the Southern Hemisphere; not Atlantic or eastern/central Pacific coverage.';
const ATTRIBUTION =
  'Joint Typhoon Warning Center (U.S. Navy / U.S. Air Force), public domain';
const HOUR = 3600_000;
const RSS_CAP = 512 * 1024;
const TCW_CAP = 64 * 1024;
const KMZ_CAP = 3 * 1024 * 1024;
const KML_CAP = 4 * 1024 * 1024;
const MAX_STORMS = 24;
/** Basins JTWC is the primary warning agency for; NHC owns the others. */
const BASINS = Object.freeze({ io: 'IO', wp: 'WP', sh: 'SH' });
const OUTLOOKS = Object.freeze({
  io: `${PRODUCTS}abioweb.txt`,
  wp: `${PRODUCTS}abpwweb.txt`,
  sh: HOME_URL,
});
const CLASSIFICATIONS = Object.freeze([
  ['SUPER TYPHOON', 'STY'],
  ['TYPHOON', 'TY'],
  ['HURRICANE', 'HU'],
  ['TROPICAL STORM', 'TS'],
  ['TROPICAL DEPRESSION', 'TD'],
  ['TROPICAL CYCLONE', 'TC'],
  ['SUBTROPICAL STORM', 'SS'],
]);

function invalid() {
  return new Error('invalid_jtwc_data');
}

/**
 * Storm products the RSS index links to, one per warning. Only io/wp/sh
 * product codes are kept; the JTWC also mirrors NHC's eastern Pacific storms.
 */
export function parseJtwcIndex(rss) {
  const storms = [];
  const seen = new Set();
  const text = String(rss);
  const headers = [
    ...text.matchAll(
      /<b>\s*([A-Z][A-Za-z ]+?)\s+(\d{2}[A-Z])\s+\(([^)]*)\)\s+Warning\s+#(\d{1,3})\s*<\/b>/g,
    ),
  ];
  headers.forEach((header, index) => {
    const from = header.index;
    const to = headers[index + 1]?.index ?? text.length;
    const section = text.slice(from, to);
    const product = section.match(
      /\/jtwc\/products\/((io|wp|sh)(\d{2})(\d{2}))\.tcw/,
    );
    if (!product) return;
    const [, code, basin, number, year] = product;
    if (seen.has(code) || storms.length >= MAX_STORMS) return;
    seen.add(code);
    const kind = header[1].trim().toUpperCase();
    storms.push({
      code,
      basin,
      id: `${basin}${number}20${year}`,
      designation: header[2],
      name: header[3].trim(),
      classification:
        CLASSIFICATIONS.find(([label]) => kind === label)?.[1] || 'TC',
      warningNumber: String(Number(header[4])),
    });
  });
  return storms;
}

function coordinate(latText, latHemi, lonText, lonHemi) {
  const latitude = (Number(latText) / 10) * (latHemi === 'S' ? -1 : 1);
  const longitude = (Number(lonText) / 10) * (lonHemi === 'W' ? -1 : 1);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw invalid();
  return { longitude, latitude };
}
function warningTime(yyyymmddhh) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(yyyymmddhh);
  if (!m) throw invalid();
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
  if (!Number.isFinite(ms)) throw invalid();
  return ms;
}
/** DDHHMM from the product header, anchored to the warning month; issue never precedes the warning position. */
function issueTime(ddhhmm, positionMs) {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(ddhhmm);
  if (!m) return positionMs;
  const at = new Date(positionMs);
  let ms = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), +m[1], +m[2], +m[3]);
  if (ms < positionMs - 12 * HOUR)
    ms = Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth() + 1,
      +m[1],
      +m[2],
      +m[3],
    );
  return Number.isFinite(ms) && ms >= positionMs && ms - positionMs < 24 * HOUR
    ? ms
    : positionMs;
}
function number(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * Parse a JTWC JMV 3.0 warning file: the header line, the fix line and one
 * `Tnnn` line per forecast hour, followed by the plain-text warning (gusts,
 * central pressure). Returns the storm fields the cyclone schema needs.
 */
export function parseJmv(text) {
  const lines = String(text).split(/\r?\n/);
  const header = lines[0]?.trim().split(/\s+/) || [];
  const fixLine = lines.find((line) => /^\d{10}\s+\d{2}[A-Z]\s+/.test(line));
  if (!fixLine) throw invalid();
  const fix = fixLine.trim().split(/\s+/);
  const positionMs = warningTime(fix[0]);
  const forecastPoints = [];
  let last = -1;
  for (const line of lines) {
    const m =
      /^T(\d{3})\s+(\d{3})([NS])\s+(\d{4})([EW])\s+(\d{3})(?:\s|$)/.exec(line);
    if (!m) continue;
    const tauHours = Number(m[1]);
    if (tauHours <= last || tauHours > 168) throw invalid();
    last = tauHours;
    const radii = {};
    for (const r of line.matchAll(
      /R(034|050|064)\s+(\d{3}) NE QD (\d{3}) SE QD (\d{3}) SW QD (\d{3}) NW QD/g,
    ))
      radii[`r${Number(r[1])}`] = [r[2], r[3], r[4], r[5]].map(Number);
    forecastPoints.push({
      tauHours,
      position: coordinate(m[2], m[3], m[4], m[5]),
      windKt: number(m[6], 0, 300),
      gustKt: null,
      radiiNm: radii,
    });
  }
  if (!forecastPoints.length || forecastPoints[0].tauHours !== 0)
    throw invalid();
  const gusts = [...String(text).matchAll(/GUSTS\s+(\d{3})\s+KT/g)].map((g) =>
    number(g[1], 0, 350),
  );
  if (gusts.length === forecastPoints.length)
    forecastPoints.forEach((point, i) => (point.gustKt = gusts[i]));
  const pressure = /MINIMUM CENTRAL PRESSURE AT \d{6}Z IS (\d{3,4}) MB/.exec(
    text,
  );
  return {
    designation: fix[1],
    name: fix[2],
    warningNumber: String(Number(fix[3])),
    positionAt: new Date(positionMs).toISOString(),
    issuedAt: new Date(issueTime(header[2], positionMs)).toISOString(),
    movement: {
      directionDegrees: number(fix[5], 0, 360),
      speedKt: number(fix[6], 0, 200),
    },
    windKt: forecastPoints[0].windKt,
    pressureHpa: pressure ? number(pressure[1], 800, 1100) : null,
    forecastPoints,
  };
}

/** Read `doc.kml` out of a KMZ (a zip) without third-party code. */
export function extractKml(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw invalid();
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries && i < 64; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!/\.kml$/i.test(name)) continue;
    if (size > KML_CAP || buf.readUInt32LE(local) !== 0x04034b50)
      throw invalid();
    const start =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) return data.toString('utf8');
    if (method !== 8) throw invalid();
    const out = inflateRawSync(data, { maxOutputLength: KML_CAP });
    return out.toString('utf8');
  }
  throw invalid();
}

function kmlCoordinates(text) {
  const points = [];
  for (const token of String(text).trim().split(/\s+/)) {
    const [lon, lat] = token.split(',').map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw invalid();
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) throw invalid();
    points.push([lon, lat]);
    if (points.length > 10_000) throw invalid();
  }
  return points;
}

/** Forecast track (LineString) and the 34-knot danger swath (Polygon) from JTWC's KML. */
export function parseKml(kml) {
  const placemarks = [
    ...String(kml).matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g),
  ];
  let track = null,
    cone = null;
  for (const [, body] of placemarks) {
    const name = (/<name>([^<]*)<\/name>/.exec(body)?.[1] || '').trim();
    if (/Storm Track$/i.test(name) && !track) {
      const coords =
        /<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(body);
      if (coords) {
        const points = kmlCoordinates(coords[1]);
        if (points.length >= 2)
          track = { type: 'LineString', coordinates: points };
      }
    } else if (/Danger Swath/i.test(name) && !cone) {
      const coords =
        /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(
          body,
        );
      if (coords) {
        const ring = kmlCoordinates(coords[1]);
        if (ring.length >= 3) {
          const [f, l] = [ring[0], ring[ring.length - 1]];
          if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
          if (ring.length >= 4) cone = { type: 'Polygon', coordinates: [ring] };
        }
      }
    }
  }
  return { track, cone };
}

/** Assemble one storm in the NHC-compatible cyclone schema. */
export function buildStorm(index, jmv, geometry) {
  const current = Boolean(geometry?.track && geometry?.cone);
  return {
    id: index.id,
    name: index.name || jmv.name,
    classification: index.classification,
    basin: BASINS[index.basin],
    designation: index.designation,
    position: jmv.forecastPoints[0].position,
    positionAt: jmv.positionAt,
    advisoryNumber: index.warningNumber || jmv.warningNumber,
    issuedAt: jmv.issuedAt,
    windKt: jmv.windKt,
    pressureHpa: jmv.pressureHpa,
    movement: jmv.movement,
    advisoryUrl: `${PRODUCTS}${index.code}web.txt`,
    outlookUrl: OUTLOOKS[index.basin],
    geometryStatus: current ? 'current' : 'unavailable',
    geometryAdvisoryNumber: current
      ? index.warningNumber || jmv.warningNumber
      : null,
    forecastPoints: current
      ? jmv.forecastPoints.map(({ radiiNm, ...point }) => point)
      : [],
    track: current ? geometry.track : null,
    cone: current ? geometry.cone : null,
  };
}

/** Fixed official endpoints; one shared bounded refresh; no user destinations. */
export function jtwcProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 30_000,
} = {}) {
  let cache = null;
  let operation = null;
  let attemptedAt = -Infinity;

  async function upstream(url, cap, signal, bytes = false) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: bytes
          ? 'application/vnd.google-earth.kmz,*/*'
          : 'text/plain,*/*',
        'User-Agent': 'Gods Eye View (public JTWC tropical cyclone context)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('jtwc_upstream_unavailable');
    }
    const result = bytes
      ? await readResponseBytesCapped(response, cap)
      : await readResponseTextCapped(response, cap, signal);
    signal.throwIfAborted();
    return result;
  }

  async function refresh(signal) {
    const index = parseJtwcIndex(await upstream(RSS_URL, RSS_CAP, signal));
    const storms = [];
    let failures = 0;
    for (const entry of index) {
      try {
        const jmv = parseJmv(
          await upstream(`${PRODUCTS}${entry.code}.tcw`, TCW_CAP, signal),
        );
        let geometry = null;
        try {
          geometry = parseKml(
            extractKml(
              await upstream(
                `${PRODUCTS}${entry.code}.kmz`,
                KMZ_CAP,
                signal,
                true,
              ),
            ),
          );
        } catch (error) {
          if (signal.aborted) throw error;
          // Position and forecast text still stand without the overlay.
          geometry = null;
        }
        storms.push(buildStorm(entry, jmv, geometry));
      } catch (error) {
        if (signal.aborted) throw error;
        failures++;
      }
    }
    signal.throwIfAborted();
    if (index.length && failures === index.length)
      throw new Error('jtwc_products_unavailable');
    cache = { storms, fetchedAt: now() };
    return cache;
  }

  async function acquire(signal) {
    signal.throwIfAborted();
    if (cache && now() - cache.fetchedAt < 600_000) return cache;
    if (operation?.controller.signal.aborted) operation = null;
    if (!operation) {
      if (now() - attemptedAt < 60_000) throw new Error('jtwc_retry_later');
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
      throw Object.assign(new Error('jtwc_busy'), { status: 429 });
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
      source: 'JTWC',
      attribution: ATTRIBUTION,
      coverage: COVERAGE,
      fetchedAt: value?.fetchedAt ?? null,
      stale: stale || !value,
      unavailable: !value,
      reason: !value
        ? 'JTWC warnings unavailable'
        : stale
          ? 'Cached JTWC warning; upstream unavailable'
          : null,
      storms: value?.storms ?? [],
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
        return json(400, { error: 'invalid_jtwc_query' });
      try {
        json(200, describe(await acquire(controller.signal)));
      } catch (error) {
        if (error.status === 429) return json(429, { error: 'jtwc_busy' });
        const usable =
          cache &&
          now() - cache.fetchedAt <= 12 * HOUR &&
          cache.storms.every(
            (storm) => now() - Date.parse(storm.issuedAt) <= 12 * HOUR,
          );
        json(200, describe(usable ? cache : null, true));
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'jtwc',
    configureServer({ middlewares }) {
      middlewares.use('/api/jtwc', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/jtwc', handler);
    },
  };
}
