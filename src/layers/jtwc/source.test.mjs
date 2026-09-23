import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJtwcSnapshot, createJtwcSource } from './source.js';
import { createJtwcLayer, JTWC_CYCLONE_PROFILE } from './index.js';
import { validateCycloneSnapshot } from '../cyclones/source.js';

const time = '2026-09-23T15:00:00.000Z';
const storm = (overrides = {}) => ({
  id: 'io012026',
  name: 'One',
  classification: 'TC',
  basin: 'IO',
  position: { longitude: 84, latitude: 17.8 },
  positionAt: '2026-09-23T12:00:00.000Z',
  issuedAt: time,
  advisoryNumber: '4',
  windKt: 45,
  pressureHpa: 990,
  movement: { directionDegrees: 270, speedKt: 6 },
  advisoryUrl: 'https://www.metoc.navy.mil/jtwc/products/io0126web.txt',
  outlookUrl: 'https://www.metoc.navy.mil/jtwc/products/abioweb.txt',
  geometryStatus: 'unavailable',
  geometryAdvisoryNumber: null,
  forecastPoints: [],
  track: null,
  cone: null,
  ...overrides,
});
const snapshot = (storms = [storm()]) => ({
  schemaVersion: 1,
  source: 'JTWC',
  attribution: 'JTWC',
  coverage: 'JTWC basins',
  fetchedAt: Date.parse(time),
  stale: false,
  unavailable: false,
  reason: null,
  storms,
});

test('JTWC ids and product links validate; NHC rules still reject them', () => {
  const result = validateJtwcSnapshot(snapshot());
  assert.equal(result.storms[0].id, 'io012026');
  assert.equal(result.storms[0].basin, 'IO');
  assert.throws(() => validateCycloneSnapshot(snapshot()), /Malformed/);
  for (const overrides of [
    { id: 'al012026' },
    { basin: 'WP' },
    { advisoryUrl: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml' },
    { advisoryUrl: 'https://www.metoc.navy.mil/jtwc/products/io0126web.txt?x=1' },
    { outlookUrl: 'https://www.metoc.navy.mil/jtwc/products/io0126.kmz' },
    { classification: 'a very long classification code' },
  ])
    assert.throws(
      () => validateJtwcSnapshot(snapshot([storm(overrides)])),
      /Malformed/,
      JSON.stringify(overrides),
    );
  assert.equal(
    validateJtwcSnapshot(
      snapshot([storm({ outlookUrl: 'https://www.metoc.navy.mil/jtwc/jtwc.html' })]),
    ).storms[0].outlookUrl,
    'https://www.metoc.navy.mil/jtwc/jtwc.html',
  );
});

test('the JTWC layer is the shared cyclone layer under its own id, wording and pick owner', () => {
  const layer = createJtwcLayer({ feed: { getSnapshot: async () => snapshot() } });
  assert.equal(layer.id, 'weather-cyclones-jtwc');
  assert.equal(layer.source, 'JTWC');
  assert.equal(JTWC_CYCLONE_PROFILE.overlaySourceId, 'weather-cyclones-jtwc');
  const controls = layer.getRowControls();
  assert.match(controls.list.ariaLabel, /JTWC/);
  assert.match(controls.summary.detail, /unavailable/i);
  assert.match(controls.infoTitle, /danger swath/);
  assert.match(controls.infoTitle, /not a center-track uncertainty cone/);
  layer.destroy();
});

test('the source fetches /api/jtwc same-origin and validates', async () => {
  let seen;
  const source = createJtwcSource({
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(snapshot()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await source.getSnapshot({ signal: new AbortController().signal });
  assert.equal(seen.url, '/api/jtwc');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(result.storms[0].name, 'One');
});
