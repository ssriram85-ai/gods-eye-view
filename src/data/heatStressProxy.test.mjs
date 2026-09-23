import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  heatStressProxy,
  parseHeatStress,
  IMD_THRESHOLD_C,
} from '../../server/providers/heat-stress.js';
import { HEAT_STRESS_POINTS } from '../../server/providers/heat-stress/catalog.js';

const POINTS = [
  { id: 'tn-chennai', name: 'Chennai', region: 'TN', latitude: 13.08, longitude: 80.27, coastal: true },
  { id: 'dl-new-delhi', name: 'New Delhi', region: 'DL', latitude: 28.61, longitude: 77.21, coastal: false },
];
const row = (overrides = {}) => ({
  current: {
    time: '2026-09-23T16:15',
    temperature_2m: 28.4,
    relative_humidity_2m: 75,
    apparent_temperature: 32.1,
    wind_speed_10m: 10.8,
  },
  daily: {
    time: ['2026-09-23', '2026-09-24'],
    apparent_temperature_max: [36.9, 37.1],
    temperature_2m_max: [33.5, 33.2],
  },
  ...overrides,
});

test('the catalog is well formed: unique ids, valid coordinates, Tamil Nadu present', () => {
  const ids = new Set(HEAT_STRESS_POINTS.map((p) => p.id));
  assert.equal(ids.size, HEAT_STRESS_POINTS.length);
  assert.ok(HEAT_STRESS_POINTS.length >= 80);
  for (const p of HEAT_STRESS_POINTS) {
    assert.ok(p.latitude > 6 && p.latitude < 36, p.name);
    assert.ok(p.longitude > 68 && p.longitude < 98, p.name);
    assert.equal(typeof p.coastal, 'boolean');
  }
  assert.ok(HEAT_STRESS_POINTS.filter((p) => p.region === 'TN').length >= 20);
});

test('samples normalize with IMD thresholds by coast, and bad rows are dropped not invented', () => {
  const { samples, dropped } = parseHeatStress(
    [row(), row({ daily: { temperature_2m_max: [41.2, 40], apparent_temperature_max: [45, 44] } })],
    POINTS,
  );
  assert.equal(dropped, 0);
  assert.equal(samples[0].id, 'tn-chennai');
  assert.equal(samples[0].observedAt, '2026-09-23T16:15:00.000Z');
  assert.equal(samples[0].feelsLikeC, 32.1);
  assert.equal(samples[0].imdThresholdC, IMD_THRESHOLD_C.coastal);
  assert.equal(samples[0].imdThresholdMet, false);
  assert.equal(samples[1].imdThresholdC, IMD_THRESHOLD_C.plains);
  assert.equal(samples[1].imdThresholdMet, true);
  assert.equal(samples[1].feelsLikeMaxTomorrowC, 44);
  const partial = parseHeatStress([row(), { current: { time: 'bad' } }], POINTS);
  assert.equal(partial.samples.length, 1);
  assert.equal(partial.dropped, 1);
  assert.throws(() => parseHeatStress([row()], POINTS), /mismatch/);
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-length': String(Buffer.byteLength(body)) }),
    body: null,
    text: async () => body,
  };
}
async function invoke(plugin, url = '/', method = 'GET') {
  const middlewares = { use: (_path, handler) => (plugin.handler = handler) };
  plugin.configureServer({ middlewares });
  const res = new EventEmitter();
  let status, body;
  res.writeHead = (code) => (status = code);
  res.end = (value) => (body = JSON.parse(value));
  await plugin.handler({ method, url }, res);
  return { status, body };
}

test('proxy asks Open-Meteo for the whole catalog in one request, caches, and goes stale on outage', async () => {
  let now = Date.parse('2026-09-23T16:20:00Z');
  let down = false;
  const urls = [];
  const plugin = heatStressProxy({
    now: () => now,
    points: POINTS,
    fetchImpl: async (url) => {
      urls.push(url);
      return down ? response('', 503) : response(JSON.stringify([row(), row()]));
    },
  });
  const first = await invoke(plugin);
  assert.equal(first.status, 200);
  assert.equal(first.body.samples.length, 2);
  assert.equal(first.body.source, 'Open-Meteo');
  const url = new URL(urls[0]);
  assert.equal(url.origin, 'https://api.open-meteo.com');
  assert.equal(url.searchParams.get('latitude'), '13.0800,28.6100');
  assert.match(url.searchParams.get('current'), /apparent_temperature/);
  now += 60_000;
  await invoke(plugin);
  assert.equal(urls.length, 1, 'served from cache inside the window');
  down = true;
  now += 16 * 60_000;
  const stale = await invoke(plugin);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.samples.length, 2);
  assert.equal((await invoke(plugin, '/?x=1')).status, 400);
  assert.equal((await invoke(plugin, '/', 'POST')).status, 405);
});
