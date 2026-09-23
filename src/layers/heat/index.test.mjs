import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeatStressLayer } from './index.js';
import { validateHeatStressSnapshot } from './source.js';
import { bandFor, rankSamples, sampleRowText } from './model.js';

const sample = (id, overrides = {}) => ({
  id,
  name: id,
  region: 'TN',
  coastal: true,
  position: { longitude: 80.27, latitude: 13.08 },
  observedAt: '2026-09-23T16:15:00.000Z',
  feelsLikeC: 33,
  airC: 29,
  humidityPct: 70,
  windKmh: 10,
  feelsLikeMaxTodayC: 38,
  feelsLikeMaxTomorrowC: 41.5,
  airMaxTodayC: 34,
  imdThresholdC: 37,
  imdThresholdMet: false,
  ...overrides,
});
const snapshot = (samples) => ({
  schemaVersion: 1,
  source: 'Open-Meteo',
  attribution: 'Open-Meteo',
  coverage: 'catalog',
  fetchedAt: 1,
  stale: false,
  unavailable: false,
  reason: null,
  dropped: 0,
  samples,
});
const cesium = {
  ScreenSpaceEventType: { LEFT_CLICK: 'left' },
  ScreenSpaceEventHandler: class {
    setInputAction(cb) {
      this.click = cb;
    }
    destroy() {}
    isDestroyed() {
      return false;
    }
  },
};
const viewer = { scene: { canvas: {}, pick: () => null }, camera: {} };
function stubRendering() {
  const calls = { snapshots: [], cleared: 0 };
  return {
    calls,
    async setSnapshot(samples, mode) {
      calls.snapshots.push([mode, samples.map((s) => s.id)]);
      return true;
    },
    setSelection() {},
    clear() {
      calls.cleared++;
    },
    destroy() {},
    pickSample: () => null,
    ownsPickId: () => false,
    getFocusSphere: () => ({ radius: 1 }),
    getDiagnostics: () => ({}),
  };
}

test('bands, ranking and row text', () => {
  assert.equal(bandFor(20).id, 'normal');
  assert.equal(bandFor(27).id, 'caution');
  assert.equal(bandFor(40.9).id, 'extreme-caution');
  assert.equal(bandFor(41).id, 'danger');
  assert.equal(bandFor(55).id, 'extreme-danger');
  const ranked = rankSamples(
    [sample('a', { feelsLikeC: 30 }), sample('b', { feelsLikeC: 44 }), sample('c', { feelsLikeMaxTomorrowC: null })],
    'now',
  );
  assert.deepEqual(ranked.map((s) => s.id), ['b', 'c', 'a']);
  assert.deepEqual(
    rankSamples([sample('a'), sample('c', { feelsLikeMaxTomorrowC: null })], 'tomorrow').map((s) => s.id),
    ['a'],
  );
  assert.equal(sampleRowText(sample('x', { imdThresholdMet: true }), 'today'), 'x · feels like 38° · IMD threshold');
});

test('the validator accepts the contract and rejects out-of-range or unknown shapes', () => {
  assert.equal(validateHeatStressSnapshot(snapshot([sample('a')])).samples.length, 1);
  for (const overrides of [
    { feelsLikeC: 99 },
    { id: 'Bad Id' },
    { name: 'x<y' },
    { observedAt: '2026-09-23T16:15' },
    { coastal: 'yes' },
    { imdThresholdC: 10 },
  ])
    assert.throws(() => validateHeatStressSnapshot(snapshot([sample('a', overrides)])), /Malformed/, JSON.stringify(overrides));
  assert.throws(() => validateHeatStressSnapshot(snapshot([sample('a'), sample('a')])));
});

test('modes refilter the drawn set, the list flies to a city, and errors are reported not thrown', async () => {
  const rendering = stubRendering();
  const navigations = [];
  let fail = false;
  const layer = createHeatStressLayer({
    feed: {
      getSnapshot: async () => {
        if (fail) throw new Error('Heat stress HTTP 503');
        return snapshot([sample('chennai', { feelsLikeC: 33 }), sample('delhi', { feelsLikeC: 39, feelsLikeMaxTomorrowC: null })]);
      },
    },
    cesium,
    createRendering: () => rendering,
    matchMedia: () => ({ matches: true }),
  });
  layer.init(viewer);
  layer.attachShellServices({ runNavigation: (fn) => navigations.push(fn) });
  layer.enable();
  assert.equal(await layer.update(viewer, {}), true);
  assert.deepEqual(rendering.calls.snapshots.at(-1), ['now', ['delhi', 'chennai']]);
  let controls = layer.getRowControls();
  assert.equal(controls.list.items[0].id, 'delhi');
  assert.match(controls.info, /hottest delhi 39°/);
  assert.deepEqual(controls.legend.map((l) => l.count), [2]);
  layer.setParams({ mode: 'tomorrow' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(rendering.calls.snapshots.at(-1), ['tomorrow', ['chennai']]);
  layer.setParams({ cityId: 'chennai', focus: true });
  assert.equal(navigations.length, 1);
  assert.match(layer.getRowControls().info, /chennai, TN · feels like 33°/);
  fail = true;
  assert.equal(await layer.update(viewer, {}), true);
  assert.equal(layer.getStats().error, 'Heat stress HTTP 503');
  layer.destroy();
});
