import test from 'node:test';
import assert from 'node:assert/strict';
import { createSachetLayer } from './index.js';
import { filterAlerts, alertInRegion, istTime } from './model.js';
import { isOwnedByOtherLayer } from '../../data/pickRegistry.js';

const ring = [
  [80.0, 13.0],
  [80.1, 13.0],
  [80.1, 13.1],
  [80.0, 13.0],
];
const alert = (id, overrides = {}) => ({
  id,
  sender: 'IMD-Chennai',
  sent: '2026-09-23T14:47:24.000Z',
  status: 'Actual',
  msgType: 'Alert',
  category: 'Met',
  event: 'Heavy Rain',
  urgency: 'Expected',
  severity: 'Severe',
  certainty: 'Likely',
  onset: null,
  expires: null,
  headline: 'Heavy rain',
  description: '',
  instruction: '',
  areaDesc: 'Chennai',
  localLanguage: '',
  localHeadline: '',
  centroid: { longitude: 80.05, latitude: 13.03 },
  polygons: [ring],
  capUrl: 'https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1',
  ...overrides,
});
const snapshot = (alerts) => ({
  schemaVersion: 1,
  source: 'NDMA SACHET',
  attribution: 'NDMA SACHET',
  coverage: 'India',
  fetchedAt: 1,
  stale: false,
  unavailable: false,
  reason: null,
  indexed: alerts.length,
  unmapped: 0,
  alerts,
});
const cesium = {
  ScreenSpaceEventType: { LEFT_CLICK: 'left' },
  ScreenSpaceEventHandler: class {
    constructor() {
      this.destroyed = false;
    }
    setInputAction(callback) {
      this.click = callback;
    }
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
  },
};
function stubRendering() {
  const calls = { snapshots: [], selections: [], cleared: 0 };
  return {
    calls,
    async setSnapshot(alerts) {
      calls.snapshots.push(alerts.map((a) => a.id));
      return true;
    },
    setSelection(id) {
      calls.selections.push(id);
    },
    clear() {
      calls.cleared++;
    },
    destroy() {},
    pickAlert: (picked) => picked?.alertId || null,
    ownsPickId: (id) => id === 'sachet:tn:center',
    getFocusSphere: () => ({ radius: 1 }),
    getDiagnostics: () => ({}),
  };
}
const viewer = { scene: { canvas: {}, pick: () => null }, camera: {} };

test('region and severity filters select the drawn subset and sort most severe first', () => {
  const alerts = [
    alert('mod', { severity: 'Moderate', sent: '2026-09-23T15:00:00.000Z' }),
    alert('ap', { sender: 'Andhra-Pradesh-SDMA', areaDesc: '14 Mandals', centroid: { longitude: 79.6, latitude: 16.0 } }),
    alert('tn-extreme', { severity: 'Extreme' }),
    alert('minor', { severity: 'Minor' }),
  ];
  assert.deepEqual(
    filterAlerts(alerts, { region: 'india', minSeverity: 'Moderate' }).map((a) => a.id),
    ['tn-extreme', 'ap', 'mod'],
  );
  assert.deepEqual(
    filterAlerts(alerts, { region: 'tamil-nadu', minSeverity: 'Unknown' }).map((a) => a.id),
    ['tn-extreme', 'mod', 'minor'],
  );
  assert.equal(alertInRegion(alert('x', { sender: 'Tamil-Nadu-SDMA', centroid: null, polygons: [] }), 'tamil-nadu'), true);
  assert.equal(istTime('2026-09-23T14:47:24.000Z'), '23 Sep 20:17 IST');
});

test('update draws the filtered alerts, chips refilter, list selection focuses, and disable clears', async () => {
  const rendering = stubRendering();
  const navigations = [];
  const layer = createSachetLayer({
    feed: {
      getSnapshot: async () =>
        snapshot([
          alert('tn'),
          alert('ap', { sender: 'IMD-Hyderabad', areaDesc: 'Guntur', centroid: { longitude: 79.6, latitude: 16.0 } }),
          alert('minor', { severity: 'Minor' }),
        ]),
    },
    cesium,
    createRendering: () => rendering,
    matchMedia: () => ({ matches: true }),
  });
  layer.init(viewer);
  layer.attachShellServices({ runNavigation: (fn) => navigations.push(fn) });
  layer.enable();
  assert.equal(await layer.update(viewer, {}), true);
  assert.deepEqual(rendering.calls.snapshots.at(-1), ['tn', 'ap']);
  assert.equal(layer.getStats().count, 2);
  let controls = layer.getRowControls();
  assert.equal(controls.list.items.length, 2);
  assert.ok(controls.chips.some((chip) => chip.id === 'region-tamil-nadu'));
  assert.deepEqual(controls.legend.map((row) => [row.label, row.count]), [['Severe', 2]]);
  assert.match(controls.info, /2 of 3 alerts shown/);

  layer.setParams({ region: 'tamil-nadu' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(rendering.calls.snapshots.at(-1), ['tn']);
  layer.setParams({ minSeverity: 'Unknown' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(rendering.calls.snapshots.at(-1), ['tn', 'minor']);

  layer.setParams({ alertId: 'tn', focus: true });
  assert.equal(layer.getParams().alertId, 'tn');
  assert.equal(navigations.length, 1);
  controls = layer.getRowControls();
  assert.match(controls.info, /Severe · Heavy Rain/);
  assert.equal(controls.list.items.find((item) => item.id === 'tn').active, true);
  assert.equal(isOwnedByOtherLayer('flights', 'sachet:tn:center'), true);

  layer.setParams({ alertId: 'not-visible' });
  assert.equal(layer.getParams().alertId, 'tn', 'an unknown id changes nothing');
  layer.setParams({ clear: true });
  assert.equal(layer.getParams().alertId, null);

  layer.disable();
  assert.ok(rendering.calls.cleared >= 1);
  assert.equal(layer.getStats().count, 0);
  assert.equal(isOwnedByOtherLayer('flights', 'sachet:tn:center'), false);
  layer.destroy();
});

test('an unavailable snapshot clears the map and reports the reason; errors never throw', async () => {
  const rendering = stubRendering();
  let mode = 'unavailable';
  const layer = createSachetLayer({
    feed: {
      getSnapshot: async () => {
        if (mode === 'throw') throw new Error('SACHET HTTP 503');
        return { ...snapshot([]), unavailable: true, stale: true, reason: 'SACHET alerts unavailable' };
      },
    },
    cesium,
    createRendering: () => rendering,
  });
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(viewer, {}), true);
  assert.equal(layer.getStats().error, 'SACHET alerts unavailable');
  mode = 'throw';
  assert.equal(await layer.update(viewer, {}), true);
  assert.equal(layer.getStats().error, 'SACHET HTTP 503');
  assert.match(layer.getRowControls().info, /SACHET HTTP 503/);
  layer.destroy();
});
