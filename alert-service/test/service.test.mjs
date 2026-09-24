import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { haversineKm, pointInPolygon, distanceToLineKm } from '../src/geo.mjs';
import { normalizeSachet, normalizeJtwc, normalizeHeat } from '../src/feeds.mjs';
import { matchOne, matchAll } from '../src/match.mjs';
import { createService, normalizeAsset } from '../src/service.mjs';
import { sign, deliver } from '../src/deliver.mjs';

const CHENNAI = { latitude: 13.0827, longitude: 80.2707 };
const CHENNAI_BOX = [[80.1, 12.95], [80.4, 12.95], [80.4, 13.25], [80.1, 13.25], [80.1, 12.95]];

const sachet = (overrides = {}) => ({
  schemaVersion: 1, stale: false, unavailable: false,
  alerts: [{ id: 'IN-1_1', sender: 'IMD-Chennai', category: 'Met', event: 'Heavy Rain', severity: 'Severe', headline: 'Heavy rain over Chennai', instruction: 'Avoid waterlogged roads', onset: null, expires: null, capUrl: 'https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1', polygons: [CHENNAI_BOX], ...overrides }],
});
const jtwc = () => ({
  schemaVersion: 1, stale: false, unavailable: false,
  storms: [{ id: 'io012026', name: 'One', classification: 'TC', windKt: 45, advisoryNumber: '4', issuedAt: '2026-09-23T15:00:00.000Z', advisoryUrl: 'https://www.metoc.navy.mil/jtwc/products/io0126web.txt',
    cone: { type: 'Polygon', coordinates: [[[83, 17], [85, 17], [85, 19], [83, 19], [83, 17]]] },
    track: { type: 'LineString', coordinates: [[84, 17.8], [83.5, 18.3], [83.2, 18.8]] }, forecastPoints: [] }],
});
const heat = (feelsLike = 43, peak = 44) => ({
  schemaVersion: 1, stale: false, unavailable: false,
  samples: [{ id: 'tn-chennai', name: 'Chennai', region: 'TN', coastal: true, position: { longitude: 80.2707, latitude: 13.0827 }, observedAt: '2026-09-24T06:00:00.000Z', feelsLikeC: feelsLike, feelsLikeMaxTodayC: peak, airMaxTodayC: 38, imdThresholdMet: true }],
});

test('geometry helpers', () => {
  assert.ok(Math.abs(haversineKm(13.0827, 80.2707, 12.9716, 77.5946) - 291) < 5, 'Chennai to Bengaluru ~291 km');
  assert.equal(pointInPolygon(80.27, 13.08, [CHENNAI_BOX]), true);
  assert.equal(pointInPolygon(77.59, 12.97, [CHENNAI_BOX]), false);
  assert.ok(distanceToLineKm(84, 18.3, [[84, 17.8], [84, 18.8]]) < 1);
  assert.ok(Math.abs(distanceToLineKm(85, 18.3, [[84, 17.8], [84, 18.8]]) - 105) < 6);
});

test('feeds normalize into events with geometry and mapped severities', () => {
  const s = normalizeSachet(sachet());
  assert.equal(s[0].id, 'sachet:IN-1_1');
  assert.equal(s[0].severity, 'warning');
  assert.equal(s[0].geometry.type, 'polygon');
  const j = normalizeJtwc(jtwc());
  assert.deepEqual(j.map((e) => [e.id, e.severity, e.geometry.type]), [
    ['jtwc:io012026:4:swath', 'critical', 'polygon'],
    ['jtwc:io012026:4:corridor', 'warning', 'line'],
  ]);
  const h = normalizeHeat(heat());
  assert.equal(h[0].severity, 'critical');
  assert.equal(h[0].geometry.radiusKm, 40);
  assert.equal(normalizeHeat(heat(30, 33))[0].severity, 'warning');
  assert.deepEqual(normalizeSachet({ unavailable: true }), []);
});

test('matching: polygon, corridor, city radius, thresholds and expiry', () => {
  const asset = normalizeAsset({ product: 'shelflifepro', id: 'loc-1', name: 'Guindy warehouse', ...CHENNAI });
  const [rain] = normalizeSachet(sachet());
  assert.equal(matchOne(rain, asset), 'inside the warning area');
  assert.equal(matchOne(rain, normalizeAsset({ product: 'x', id: 'blr', latitude: 12.97, longitude: 77.59 })), null);
  assert.equal(matchOne({ ...rain, expires: '2020-01-01T00:00:00.000Z' }, asset), null, 'expired events never match');
  assert.equal(matchOne({ ...rain, severity: 'info' }, asset), null, 'below the warning floor by default');
  assert.match(matchOne({ ...rain, severity: 'info' }, normalizeAsset({ product: 'x', id: 'a', ...CHENNAI, thresholds: { min_severity: 'info' } })), /inside/);
  const [swath, corridor] = normalizeJtwc(jtwc());
  const vizag = normalizeAsset({ product: 'x', id: 'vizag', latitude: 17.69, longitude: 83.22 });
  assert.equal(matchOne(swath, vizag), 'inside the warning area');
  assert.match(matchOne(corridor, vizag), /km from the forecast track/);
  assert.equal(matchOne(corridor, asset), null, 'Chennai is far from the Bay of Bengal track');
  const [hot] = normalizeHeat(heat(43, 44));
  assert.match(matchOne(hot, asset), /km from the nearest sampled city/);
  assert.equal(matchOne(hot, normalizeAsset({ product: 'x', id: 'a', ...CHENNAI, thresholds: { heat_feels_like_c: 45 } })), null, 'asset threshold above the peak');
  assert.equal(matchAll([rain, swath, corridor, hot], [asset, vizag]).length, 4);
});

test('asset registration validates and never leaks secrets', () => {
  assert.throws(() => normalizeAsset({ product: 'Shelf Life', id: 'x', ...CHENNAI }), /slug/);
  assert.throws(() => normalizeAsset({ product: 'slp', id: 'x', latitude: 95, longitude: 80 }), /latitude/);
  assert.throws(() => normalizeAsset({ product: 'slp', id: 'x', ...CHENNAI, webhook_url: 'ftp://x' }), /http/);
  assert.throws(() => normalizeAsset({ product: 'slp', id: 'x', ...CHENNAI, thresholds: { min_severity: 'severe' } }), /min_severity/);
  const a = normalizeAsset({ product: 'slp', id: 'loc-7', tenant_id: 3, ...CHENNAI, radius_km: 5, webhook_url: 'https://app.example/api/webhooks/gev', webhook_secret: 's3cret' });
  assert.equal(a.key, 'slp:loc-7');
  assert.equal(a.tenant_id, '3');
});

test('signed delivery retries on 5xx, stops on 4xx, and the signature verifies', async () => {
  const calls = [];
  let status = 503;
  const asset = normalizeAsset({ product: 'slp', id: 'a', ...CHENNAI, webhook_url: 'https://app.example/hook', webhook_secret: 'topsecret' });
  const result = await deliver({
    asset,
    payload: { type: 'hazard.matched', event: { id: 'e1' } },
    attempts: 3,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const code = status;
      status = 200;
      return { ok: code < 300, status: code };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  const { body, headers } = calls[1].init;
  assert.equal(headers['X-GEV-Signature'], sign(body, 'topsecret'));
  assert.equal(headers['X-GEV-Signature'], `sha256=${createHmac('sha256', 'topsecret').update(body).digest('hex')}`);
  assert.equal(JSON.parse(body).delivery_id, headers['X-GEV-Delivery']);
  const refused = await deliver({ asset, payload: { type: 'hazard.matched', event: { id: 'e2' } }, sleep: async () => {}, fetchImpl: async () => ({ ok: false, status: 400 }) });
  assert.equal(refused.attempts, 1);
  assert.equal(refused.ok, false);
});

test('the service delivers new matches once, escalations, and clearances only from healthy feeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gev-alerts-'));
  const posted = [];
  let feed = { sachet: sachet(), jtwc: { unavailable: true, storms: [] }, heat: { unavailable: true, samples: [] } };
  let sachetDown = false;
  const fetchImpl = async (url, init) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    }
    if (url.endsWith('/api/sachet')) {
      if (sachetDown) return { ok: false, status: 503 };
      return { ok: true, status: 200, json: async () => feed.sachet };
    }
    if (url.endsWith('/api/jtwc')) return { ok: true, status: 200, json: async () => feed.jtwc };
    if (url.endsWith('/api/heat-stress')) return { ok: true, status: 200, json: async () => feed.heat };
    throw new Error(`unexpected ${url}`);
  };
  const service = createService({ baseUrl: 'http://gev', dataDir: dir, fetchImpl, log: {} });
  service.upsertAsset({ product: 'shelflifepro', id: 'loc-1', tenant_id: 1, name: 'Guindy', ...CHENNAI, webhook_url: 'https://slp/hook', webhook_secret: 'k' });
  service.upsertAsset({ product: 'shelflifepro', id: 'loc-2', tenant_id: 1, name: 'Bengaluru', latitude: 12.97, longitude: 77.59, webhook_url: 'https://slp/hook', webhook_secret: 'k' });

  const first = await service.poll();
  assert.equal(first.deliveries, 1);
  assert.equal(posted[0].type, 'hazard.matched');
  assert.equal(posted[0].asset.id, 'loc-1');
  assert.equal(posted[0].asset.has_secret, true);
  assert.equal('webhook_secret' in posted[0].asset, false);
  assert.equal(posted[0].event.id, 'sachet:IN-1_1');
  assert.equal('geometry' in posted[0].event, false);

  const second = await service.poll();
  assert.equal(second.deliveries, 0, 'a known match is not re-sent');

  feed = { ...feed, sachet: sachet({ severity: 'Extreme' }) };
  const third = await service.poll();
  assert.equal(third.deliveries, 1);
  assert.equal(posted[1].type, 'hazard.escalated');
  assert.equal(posted[1].severity, 'critical');

  sachetDown = true;
  const fourth = await service.poll();
  assert.equal(fourth.deliveries, 0, 'a failed feed never clears its matches');
  assert.equal(service.listMatches({ asset: 'shelflifepro:loc-1' }).length, 1);

  sachetDown = false;
  feed = { ...feed, sachet: { ...sachet(), alerts: [] } };
  const fifth = await service.poll();
  assert.equal(fifth.deliveries, 1);
  assert.equal(posted[2].type, 'hazard.cleared');
  assert.equal(service.listMatches().length, 0);

  const reloaded = createService({ baseUrl: 'http://gev', dataDir: dir, fetchImpl, log: {} });
  assert.equal(reloaded.listAssets().length, 2, 'assets survive a restart');
  assert.equal(reloaded.health().assets, 2);
});
