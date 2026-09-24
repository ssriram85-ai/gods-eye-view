import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resamplePolyline,
  resolveCorridor,
  sampleCorridor,
  createCorridorStore,
  profile,
  compareProfiles,
  slotOf,
  SEED_CORRIDORS,
} from '../src/corridor.mjs';
import { renderReport } from '../src/report.mjs';

// A straight north-south road, 10 km long, as TomTom routing would return it.
const ROUTE = { routes: [{ summary: { lengthInMeters: 10_000, travelTimeInSeconds: 900 }, legs: [{ points: Array.from({ length: 11 }, (_, i) => ({ latitude: 13.0 - i * 0.009, longitude: 80.25 })) }] }] };
const flow = (currentSpeed, freeFlowSpeed = 60) => ({ flowSegmentData: { frc: 'FRC2', currentSpeed, freeFlowSpeed, currentTravelTime: Math.round(1000 / currentSpeed * 3.6), freeFlowTravelTime: 60, confidence: 0.9, roadClosure: false } });

test('resampling spaces points evenly by road distance', () => {
  const { points, lengthKm } = resamplePolyline(ROUTE.routes[0].legs[0].points.map((p) => ({ lat: p.latitude, lon: p.longitude })), 5);
  assert.ok(Math.abs(lengthKm - 10) < 0.2, `length ${lengthKm}`);
  assert.equal(points.length, 5);
  assert.deepEqual(points.map((p) => Math.round(p.km * 10) / 10), [1, 3, 5, 7, 9]);
  assert.ok(points[0].lat > points[4].lat);
  assert.throws(() => resamplePolyline([{ lat: 1, lon: 1 }], 3), /fewer than two/);
});

test('a corridor resolves through routing and samples every point, recording failures honestly', async () => {
  const urls = [];
  let failPoint = 2;
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/routing/')) return { ok: true, json: async () => ROUTE };
    const idx = urls.filter((u) => u.includes('flowSegmentData')).length - 1;
    if (idx === failPoint) return { ok: false, status: 503 };
    return { ok: true, json: async () => flow(idx % 2 ? 20 : 55) };
  };
  const corridor = await resolveCorridor(SEED_CORRIDORS[0], { key: 'k', fetchImpl });
  assert.equal(corridor.id, 'omr-south');
  assert.equal(corridor.points.length, 12);
  assert.equal(corridor.routeTravelTimeS, 900);
  assert.match(urls[0], /calculateRoute\/13\.00670,80\.25400:12\.82500,80\.22000\/json/);
  assert.equal(urls[0].includes('key=k'), true);
  const sample = await sampleCorridor(corridor, { key: 'k', fetchImpl, now: () => Date.parse('2026-09-24T08:31:20Z') });
  assert.equal(sample.ts, '2026-09-24T08:31:00.000Z', 'timestamps snap to the minute');
  assert.equal(sample.rows.length, 12);
  assert.equal(sample.rows.filter((r) => r.error).length, 1, 'the failed point is an error, not a number');
  assert.equal(sample.rows.filter((r) => r.currentSpeed != null).length, 11);
  await assert.rejects(resolveCorridor(SEED_CORRIDORS[0], { key: '', fetchImpl }), /TOMTOM_API_KEY/);
});

test('store, series, profile and comparison find the slowdown a change caused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'corridor-'));
  const store = createCorridorStore(join(dir, 'c.db'));
  const fetchImpl = async (url) => (url.includes('/routing/') ? { ok: true, json: async () => ROUTE } : { ok: true, json: async () => flow(50) });
  const corridor = store.saveCorridor(await resolveCorridor({ id: 'test', name: 'Test road', from: { lat: 13, lon: 80.25 }, to: { lat: 12.9, lon: 80.25 }, points: 4 }, { key: 'k', fetchImpl }));
  assert.equal(store.listCorridors()[0].id, 'test');

  // Two "before" days at 50 km/h all day, one "during" day where 08:00-10:00 IST drops to 15 km/h.
  const speedAt = (day, hourIst) => (day === '2026-09-24' && hourIst >= 8 && hourIst < 10 ? 15 : 50);
  for (const day of ['2026-09-22', '2026-09-23', '2026-09-24']) {
    for (let h = 6; h < 22; h++) {
      for (const m of [0, 30]) {
        const ts = new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`).toISOString();
        store.saveSamples('test', { ts, rows: corridor.points.map((_, i) => ({ pointIndex: i, currentSpeed: speedAt(day, h), freeFlowSpeed: 60, currentTravelTime: 100, freeFlowTravelTime: 60, confidence: 0.9, roadClosure: 0, frc: 'FRC2' })) });
      }
    }
  }
  const all = store.series('test', '2026-09-21T00:00:00.000Z', '2026-09-26T00:00:00.000Z');
  assert.equal(all.length, 3 * 16 * 2);
  assert.ok(Math.abs(all[0].speed_ratio - 50 / 60) < 1e-9);
  assert.equal(slotOf('2026-09-24T03:00:00.000Z'), 8 * 60 + 30, '03:00 UTC is 08:30 IST');
});

test('slot arithmetic is IST and 15-minute', () => {
  assert.equal(slotOf('2026-09-24T02:30:00.000Z'), 8 * 60, '02:30Z is 08:00 IST');
  assert.equal(slotOf('2026-09-24T02:44:00.000Z'), 8 * 60);
  assert.equal(slotOf('2026-09-24T02:45:00.000Z'), 8 * 60 + 15);
  assert.equal(slotOf('2026-09-24T18:40:00.000Z'), 0, '18:40Z is 00:10 IST next day');
});

test('profile and comparison call out the worst slot and the mean change', () => {
  const rows = (day, speedFn) =>
    Array.from({ length: 8 }, (_, i) => {
      const ts = new Date(`${day}T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00+05:30`).toISOString();
      return { ts, speed_ratio: speedFn(8 + i / 2) / 60, mean_speed: speedFn(8 + i / 2), travel_time_s: 600, closures: 0 };
    });
  const before = profile([...rows('2026-09-22', () => 50), ...rows('2026-09-23', () => 50)]);
  const during = profile(rows('2026-09-24', (h) => (h >= 9 && h < 10 ? 15 : 50)));
  assert.equal(before.length, 8);
  assert.equal(before[0].samples, 2);
  const cmp = compareProfiles(before, during);
  assert.equal(cmp.rows.length, 8);
  assert.equal(cmp.worst.label, '09:00');
  assert.ok(Math.abs(cmp.worst.change - (15 - 50) / 60) < 1e-9);
  assert.ok(cmp.meanChange < 0 && cmp.meanChange > cmp.worst.change);
  const html = renderReport({
    corridor: { id: 'test', name: 'Test road', lengthKm: 10, points: [{}, {}] },
    series: rows('2026-09-24', () => 40),
    latest: { ts: 'x', points: [{ point_index: 0, current_speed: 40, free_flow_speed: 60 }, { point_index: 1, current_speed: 10, free_flow_speed: 60 }] },
    notes: [{ at: '2026-09-24T03:30:00.000Z', text: 'U-turns closed' }],
    comparison: cmp,
    windows: { hours: 48, a: 'A', b: 'B' },
  });
  assert.match(html, /Worst slot 09:00: 83% → 25%/);
  assert.match(html, /U-turns closed/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /<script/);
});
