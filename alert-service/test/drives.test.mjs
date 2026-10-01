import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { passTimes, analyzeDrive, cleanTrack, errorOf, createDriveStore, groundTruthText } from '../src/drives.mjs';
import { renderMethodology } from '../src/methodology.mjs';
import { renderDriveApp } from '../src/driveapp.mjs';

// A straight road due south from 13.000 to 12.900 (about 11.1 km); junctions A (start), B, C (end).
const corridor = {
  id: 'test-south', name: 'Test southbound · A → C', lengthKm: 11.1,
  points: [{ name: 'A', lat: 13.0, lon: 80.25 }, { name: 'B', lat: 12.96, lon: 80.25 }, { name: 'C', lat: 12.9, lon: 80.25 }],
  definition: { sections: [{ from: 'A', to: 'B', lengthKm: 4.4 }, { from: 'B', to: 'C', lengthKm: 6.7 }], line: [[80.25, 13.0], [80.25, 12.9]] },
};
const T0 = Date.parse('2026-10-02T03:00:00Z');
/** Drive the road: start 300 m before A, A→B at 4 min/km-ish, B→C faster; one fix every 5 s. */
function drive({ lonAt = () => 80.25, gapAt = null } = {}) {
  const track = [];
  let lat = 13.0027, t = T0;
  while (lat > 12.8975) {
    if (!(gapAt && t > gapAt[0] && t < gapAt[1])) track.push({ t, lat, lon: lonAt(lat), acc: 8 });
    const step = lat > 12.96 ? 0.0003 : 0.0006; // ~33 m then ~67 m per 5 s
    lat -= step;
    t += 5000;
  }
  return track;
}

test('junction times come from the closest approach, in order, interpolated between fixes', () => {
  const track = drive();
  const times = passTimes(track, corridor.points);
  assert.equal(times.length, 3);
  assert.ok(times.every((t) => t != null));
  // A is 0.0027° (~300 m) after the start at 0.0003° per 5 s: 9 fixes = 45 s in.
  assert.ok(Math.abs(times[0] - (T0 + 45_000)) <= 2500, `A at +${(times[0] - T0) / 1000}s`);
  // A→B is 0.04° at 0.0003° per 5 s = 666.7 s.
  assert.ok(Math.abs((times[1] - times[0]) / 1000 - 666.7) <= 5, `A→B ${(times[1] - times[0]) / 1000}s`);
  // B→C is 0.06° at 0.0006° per 5 s = 500 s.
  assert.ok(Math.abs((times[2] - times[1]) / 1000 - 500) <= 5, `B→C ${(times[2] - times[1]) / 1000}s`);
});

test('a clean drive is valid with whole-road and stretch times', () => {
  const a = analyzeDrive({ corridor, track: drive() });
  assert.equal(a.valid, true, a.problems.join('; '));
  assert.ok(Math.abs(a.actualS - 1166.7) <= 8, `actual ${a.actualS}`);
  assert.equal(a.legs.length, 2);
  assert.ok(Math.abs(a.legs[0] - 666.7) <= 5 && Math.abs(a.legs[1] - 500) <= 5);
  assert.equal(a.onRoadShare, 1);
  assert.ok(Math.abs(Date.parse(a.departedAt) - (T0 + 45_000)) <= 2500, a.departedAt);
});

test('a drive that leaves the road, skips a junction or loses GPS is not counted, and says why', () => {
  // Swing 700 m east between 12.99 and 12.93: B (12.96) is never passed within 150 m and most of A→C is off the road.
  const off = analyzeDrive({ corridor, track: drive({ lonAt: (lat) => (lat < 12.99 && lat > 12.93 ? 80.2565 : 80.25) }) });
  assert.equal(off.valid, false);
  assert.match(off.problems.join('; '), /did not pass B within 150 m/);
  assert.match(off.problems.join('; '), /% of the drive was on the road \(needs 90%\)/);
  const gap = analyzeDrive({ corridor, track: drive({ gapAt: [T0 + 300_000, T0 + 500_000] }) });
  assert.equal(gap.valid, false);
  assert.match(gap.problems.join('; '), /the GPS went quiet for 3 min \(keep the screen on\)/);
  assert.equal(analyzeDrive({ corridor, track: [] }).valid, false);
});

test('tracks are cleaned and errors banded', () => {
  const t = cleanTrack([{ t: 3, lat: 13, lon: 80 }, { t: 1, lat: 13, lon: 80, acc: 5 }, { t: 2, lat: 'x', lon: 80 }, { t: 4, lat: 13, lon: 80, acc: 400 }, { t: 5, lat: 95, lon: 80 }]);
  assert.deepEqual(t.map((p) => p.t), [1, 3]);
  assert.deepEqual(errorOf(1100, 1000), { pct: 0.1, band: 'within10' });
  assert.equal(errorOf(850, 1000).band, 'within20');
  assert.equal(errorOf(1300, 1000).band, 'over');
  assert.equal(errorOf(700, 1000).band, 'under');
  assert.equal(errorOf(null, 1000), null);
});

test('the store keeps the prediction, the outcome and the private track; the summary and list never expose tracks', () => {
  const db = new DatabaseSync(':memory:');
  const store = createDriveStore(db);
  store.start({ id: 'd1', corridorId: 'test-south', startedAt: '2026-10-02T03:00:00Z', tomtom: { ts: '2026-10-02T03:00:00Z', predS: 1260, typicalS: 1200, legs: [700, 560] } });
  const analysis = analyzeDrive({ corridor, track: drive() });
  const saved = store.finish('d1', { analysis, track: drive(), note: 'light rain', googleBand: 'within10' });
  assert.equal(saved.status, 'valid');
  assert.equal(saved.tomtom_band, 'within10'); // 1260 vs ~1167 = +8%
  assert.ok(Math.abs(saved.tomtom_error_pct - 0.08) < 0.01);
  assert.equal(saved.google_band, 'within10');
  assert.ok(JSON.parse(saved.track).length > 100);
  store.start({ id: 'd2', corridorId: 'test-south', startedAt: '2026-10-02T09:00:00Z', tomtom: null });
  store.finish('d2', { cancelled: true });
  const list = store.list();
  assert.deepEqual(list.map((d) => d.status), ['cancelled', 'valid']);
  assert.ok(list.every((d) => !('track' in d)), 'the list never carries a track');
  const [s] = store.summary();
  assert.equal(s.drives, 1);
  assert.equal(groundTruthText(s), "1 timed drive: TomTom's prediction at departure was within 10% of the real drive in 100% and within 20% in 100% (typical error 8%); Google's was within 10% in 100% of 1");
  assert.equal(groundTruthText(null), 'no timed drives yet');
});

test('the methodology page describes timed drives; the phone page is self-contained', () => {
  const road = { corridor: { id: 'test-south', name: 'Test southbound · A → C', lengthKm: 11.1, definition: { sections: [{}, {}] } }, since: null, days: { weekdays: 1, weekendDays: 0 }, source: { kind: 'unknown', share: null }, confidence: { level: 'early' } };
  const html = renderMethodology({ roads: [road], groundTruth: [{ corridor_id: 'test-south', drives: 2, tomtomWithin10: 1, tomtomWithin20: 2, medianAbsError: 0.12, google: 0, googleWithin10: 0, googleWithin20: 0 }] });
  assert.match(html, /The ground truth<\/b> is timed drives with a phone's GPS.*2 valid drives so far/s);
  assert.match(html, /Ground truth: timed drives<\/h2>/);
  assert.match(html, /2 timed drives: TomTom's prediction at departure was within 10% of the real drive in 50% and within 20% in 100% \(typical error 12%\)/);
  assert.match(html, /the GPS track is kept privately and never published/);
  const app = renderDriveApp();
  assert.doesNotMatch(app, /<script src=|<link rel="stylesheet"/, 'no external assets');
  assert.match(app, /navigator\.geolocation\.watchPosition/);
  assert.match(app, /wakeLock/);
  assert.match(app, /X-Drive-Key/);
});
