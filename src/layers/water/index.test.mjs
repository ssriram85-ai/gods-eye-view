import test from 'node:test';
import assert from 'node:assert/strict';
import { createWaterHazardsLayer } from './index.js';
import { createWaterHazardSource } from './source.js';
import {
  buildWaterQuery,
  normalizeElement,
  snapBox,
  boxContains,
  filterRecords,
  categorize,
} from './model.js';

const ELEMENTS = [
  { type: 'way', id: 1, center: { lat: 13.01, lon: 80.21 }, tags: { landuse: 'quarry', name: 'Pallavaram quarry', disused: 'yes' } },
  { type: 'way', id: 2, center: { lat: 13.02, lon: 80.22 }, tags: { natural: 'water', name: 'Chembarambakkam Lake', water: 'reservoir' } },
  { type: 'relation', id: 3, center: { lat: 13.03, lon: 80.23 }, tags: { natural: 'water', name: 'Velachery eri' } },
  { type: 'node', id: 4, lat: 13.04, lon: 80.28, tags: { natural: 'beach', name: 'Marina <b>Beach</b>' } },
  { type: 'way', id: 5, center: { lat: 13.05, lon: 80.25 }, tags: { natural: 'water', water: 'river', name: 'Adyar' } },
  { type: 'way', id: 6, center: { lat: 13.06, lon: 80.26 }, tags: { natural: 'water' } },
];

test('OSM elements categorize, clean and drop what is not a hazard class', () => {
  const records = ELEMENTS.map(normalizeElement).filter(Boolean);
  assert.deepEqual(records.map((r) => [r.id, r.category, r.name, r.disused]), [
    ['way/1', 'quarry', 'Pallavaram quarry', true],
    ['way/2', 'reservoir', 'Chembarambakkam Lake', false],
    ['relation/3', 'tank', 'Velachery eri', false],
    ['node/4', 'beach', 'Marina b Beach /b', false],
    ['way/5', 'tank', 'Adyar', false],
    ['way/6', 'tank', '', false],
  ]);
  assert.equal(categorize({ highway: 'primary' }), null);
  assert.equal(normalizeElement({ type: 'way', id: 9, tags: { landuse: 'quarry' } }), null, 'no centre, no record');
  assert.equal(records[3].osmUrl, 'https://www.openstreetmap.org/node/4');
});

test('the query is bounded per selector and excludes flowing water; boxes snap outward', () => {
  const q = buildWaterQuery({ south: 12.9, west: 80.0, north: 13.2, east: 80.3 });
  assert.equal((q.match(/\(12\.9,80,13\.2,80\.3\)/g) || []).length, 3);
  assert.match(q, /river\|canal\|stream/);
  assert.match(q, /out tags center 1200;$/);
  const snapped = snapBox({ south: 12.91, west: 80.01, north: 13.19, east: 80.29 });
  assert.deepEqual(snapped, { south: 12.9, west: 80, north: 13.2, east: 80.3 });
  assert.equal(boxContains(snapped, { south: 12.95, west: 80.05, north: 13.1, east: 80.2 }), true);
  assert.equal(boxContains(snapped, { south: 12.85, west: 80.05, north: 13.1, east: 80.2 }), false);
  assert.deepEqual(
    filterRecords(ELEMENTS.map(normalizeElement).filter(Boolean), 'all').map((r) => r.id),
    ['way/1', 'way/5', 'relation/3', 'way/6', 'way/2', 'node/4'],
    'category order, then named alphabetically, unnamed last',
  );
});

test('the source posts through the shared proxy, refuses wide boxes, and surfaces mirror refusals', async () => {
  const calls = [];
  const source = createWaterHazardSource({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ elements: ELEMENTS }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-overpass-cache': 'STALE' },
      });
    },
  });
  const result = await source.fetch({ south: 12.9, west: 80.0, north: 13.2, east: 80.3 });
  assert.equal(calls[0].url, '/api/overpass');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(decodeURIComponent(calls[0].init.body), /landuse"="quarry"\]\(12\.9,80,13\.2,80\.3\)/);
  assert.equal(result.records.length, 6);
  assert.equal(result.stale, true);
  await assert.rejects(source.fetch({ south: 10, west: 78, north: 13, east: 81 }), /bounded city viewport/);
  const refused = createWaterHazardSource({ fetchImpl: async () => new Response('', { status: 406 }) });
  await assert.rejects(refused.fetch({ south: 12.9, west: 80.0, north: 13.2, east: 80.3 }), /refused the query \(HTTP 406\)/);
});

test('the layer loads on camera moves for city views, reuses a covering box, filters, and hints when too wide', async () => {
  let box = { south: 12.95, west: 80.05, north: 13.1, east: 80.2 };
  let now = 1_000_000;
  const fetches = [];
  const rendering = {
    calls: [],
    async setSnapshot(records) {
      this.calls.push(records.map((r) => r.id));
      return true;
    },
    setSelection() {},
    clear() {},
    destroy() {},
    pickRecord: () => null,
    ownsPickId: () => false,
    getFocusSphere: () => ({ radius: 1 }),
    getDiagnostics: () => ({}),
  };
  let moveEnd = null;
  const viewer = {
    scene: { canvas: {}, pick: () => null },
    camera: {
      moveEnd: {
        addEventListener(fn) {
          moveEnd = fn;
          return () => (moveEnd = null);
        },
      },
    },
  };
  const layer = createWaterHazardsLayer({
    source: {
      async fetch(b) {
        fetches.push(b);
        return { records: ELEMENTS.map(normalizeElement).filter(Boolean), stale: false, saturated: false };
      },
    },
    cesium: {
      ScreenSpaceEventType: { LEFT_CLICK: 'left' },
      ScreenSpaceEventHandler: class {
        setInputAction() {}
        destroy() {}
        isDestroyed() {
          return false;
        }
      },
    },
    createRendering: () => rendering,
    now: () => now,
    getViewportBox: () => box,
  });
  layer.init(viewer);
  layer.enable();
  assert.equal(typeof moveEnd, 'function', 'subscribed to camera moves');
  assert.equal(await layer.update(viewer, {}), true);
  assert.deepEqual(
    fetches[0],
    { south: 12.95, west: 80.05, north: 13.1, east: 80.2 },
    'a box already on the grid snaps to itself',
  );
  assert.equal(layer.getStats().count, 6);
  let controls = layer.getRowControls();
  assert.deepEqual(controls.legend.map((l) => [l.label, l.count]), [
    ['Quarry', 1],
    ['Tank / lake / pond', 3],
    ['Reservoir', 1],
    ['Beach', 1],
  ]);
  box = { south: 12.96, west: 80.06, north: 13.09, east: 80.19 };
  assert.equal(await layer.update(viewer, {}), true, 'a reused box is still a healthy update');
  assert.equal(fetches.length, 1, 'a view inside the last box reuses it');
  layer.setParams({ filter: 'quarry' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(rendering.calls.at(-1), ['way/1']);
  assert.match(layer.getRowControls().info, /1 mapped site in view · quarries/);
  box = null;
  assert.equal(await layer.update(viewer, {}), true);
  assert.match(layer.getRowControls().info, /Zoom in to a city/);
  assert.equal(layer.getStats().count, 0);
  layer.destroy();
  assert.equal(moveEnd, null, 'unsubscribed on destroy');
});

test('a camera settle during the first load joins that load instead of aborting it', async () => {
  let resolveFetch;
  const seen = [];
  const rendering = {
    async setSnapshot() {
      return true;
    },
    setSelection() {},
    clear() {},
    destroy() {},
    pickRecord: () => null,
    ownsPickId: () => false,
    getFocusSphere: () => null,
    getDiagnostics: () => ({}),
  };
  let moveEnd = null;
  const layer = createWaterHazardsLayer({
    source: {
      fetch(b, signal) {
        seen.push({ b, signal });
        return new Promise((resolve) => (resolveFetch = resolve));
      },
    },
    cesium: {
      ScreenSpaceEventType: { LEFT_CLICK: 'left' },
      ScreenSpaceEventHandler: class {
        setInputAction() {}
        destroy() {}
        isDestroyed() {
          return false;
        }
      },
    },
    createRendering: () => rendering,
    getViewportBox: () => ({ south: 12.95, west: 80.05, north: 13.1, east: 80.2 }),
  });
  layer.init({
    scene: { canvas: {}, pick: () => null },
    camera: { moveEnd: { addEventListener: (fn) => ((moveEnd = fn), () => {}) } },
  });
  layer.enable();
  const first = layer.update({}, {});
  moveEnd();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(seen.length, 1, 'the settle joined the in-flight request');
  assert.equal(seen[0].signal.aborted, false);
  resolveFetch({ records: [], stale: false, saturated: false });
  assert.equal(await first, true);
  layer.destroy();
});
