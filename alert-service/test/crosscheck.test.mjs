import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { googleDrive, compareDrives, createCrossCheckStore, parseHours, istHour, istMonth, agreementText, bearing } from '../src/crosscheck.mjs';

const corridor = { id: 'omr-south', lengthKm: 22.6, points: [{ lat: 13.0, lon: 80.25 }, { lat: 12.95, lon: 80.24 }, { lat: 12.82, lon: 80.22 }] };
const tomtom = (legMin, freeMin) => ({ ts: '2026-10-01T12:30:00.000Z', rows: legMin.map((m, i) => ({ leg: i, travel_s: m * 60, no_traffic_s: freeMin[i] * 60 })) });

test('the request asks for live traffic through every waypoint with a narrow field mask', async () => {
  let req;
  const g = await googleDrive(corridor, {
    key: 'test-key',
    fetchImpl: async (url, init) => ((req = { url, init }), { ok: true, json: async () => ({ routes: [{ duration: '3720s', staticDuration: '2700s', distanceMeters: 22580, legs: [{ duration: '1500s', distanceMeters: 9000 }, { duration: '2220s', distanceMeters: 13580 }] }] }) }),
  });
  assert.equal(req.url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers['X-Goog-Api-Key'], 'test-key');
  assert.match(req.init.headers['X-Goog-FieldMask'], /^routes\.duration,routes\.staticDuration,routes\.distanceMeters,routes\.legs\.duration/);
  const body = JSON.parse(req.init.body);
  assert.equal(body.routingPreference, 'TRAFFIC_AWARE');
  assert.equal(body.travelMode, 'DRIVE');
  assert.deepEqual(body.intermediates, [{ location: { latLng: { latitude: 12.95, longitude: 80.24 }, heading: bearing(corridor.points[0], corridor.points[2]) } }]);
  assert.ok(!JSON.stringify(body).includes('sideOfRoad'), 'Google rejects sideOfRoad with heading');
  assert.equal(body.origin.location.heading, bearing(corridor.points[0], corridor.points[1]));
  assert.equal(body.destination.location.heading, bearing(corridor.points[1], corridor.points[2]));
  assert.equal(bearing({ lat: 13, lon: 80 }, { lat: 12, lon: 80 }), 180, 'due south');
  assert.equal(bearing({ lat: 13, lon: 80 }, { lat: 13, lon: 81 }), 90, 'due east');
  assert.deepEqual(g, { seconds: 3720, staticSeconds: 2700, meters: 22580, legs: [{ seconds: 1500, meters: 9000 }, { seconds: 2220, meters: 13580 }] });
});

test('errors carry Google\'s message; a missing key is refused before any request', async () => {
  await assert.rejects(googleDrive(corridor, { key: '', fetchImpl: async () => assert.fail('no request without a key') }), /GOOGLE_ROUTES_API_KEY is not set/);
  await assert.rejects(
    googleDrive(corridor, { key: 'k', fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Routes API has not been used in project 123 before or it is disabled.' } }) }) }),
    /Google Routes HTTP 403: Routes API has not been used/,
  );
});

test('comparison keeps only outcomes, never Google\'s numbers', () => {
  const g = { seconds: 3600, staticSeconds: 2700, meters: 22600, legs: [{ seconds: 1500 }, { seconds: 2100 }] };
  const same = compareDrives(g, tomtom([26, 37], [18, 20]), 22.6, { nightMinutes: 40 });
  assert.deepEqual(same, { outcome: 'within10', congestionAgree: 1, congestionRule: 2, legsWithin20: 2, legs: 2 }, 'Google 60 and TomTom 63 min are both heavy against a 40-min night drive');
  assert.ok(!Object.values(same).includes(3600) && !Object.values(same).includes(2700), 'no Google value is returned for storage');
  assert.equal(compareDrives(g, tomtom([30, 40], [18, 20]), 22.6).outcome, 'within20'); // 70 vs 60 min = +16.7%
  assert.equal(compareDrives(g, tomtom([40, 40], [18, 20]), 22.6).outcome, 'tomtom-higher');
  assert.equal(compareDrives(g, tomtom([20, 20], [18, 20]), 22.6).outcome, 'tomtom-lower');
  assert.deepEqual(compareDrives({ ...g, meters: 27000 }, tomtom([26, 37], [18, 20]), 22.6), { outcome: 'route-differs', note: 'longer' });
  assert.equal(compareDrives(g, tomtom([20, 30], [20, 30]), 22.6, { nightMinutes: 40 }).congestionAgree, 0, 'Google 60 min is heavy (1.5x), TomTom 50 min is not (1.25x)');
  assert.equal(compareDrives(g, tomtom([26, 37], [18, 20]), 22.6).congestionAgree, null, 'no night-time drive yet: congestion not judged');
  assert.equal(compareDrives(g, tomtom([26, 37], [18, 20]), 22.6).congestionRule, null);
  // The old rule (each against its own no-traffic time) would have called this a disagreement: TomTom 63 vs its 38 free = 1.66x, Google 60 vs 45 static = 1.33x.
  assert.equal(compareDrives(g, tomtom([26, 37], [18, 20]), 22.6, { nightMinutes: 40 }).congestionAgree, 1);
  assert.equal(compareDrives(null, tomtom([1], [1]), 1).outcome, 'no-data');
});

test('schedule hours, IST month, the store, the monthly count and the plain-language summary', () => {
  assert.deepEqual([...parseHours('3,6-23')], [3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  assert.equal([...parseHours('3,6-23')].length * 8 * 31 <= 4800, true, 'default schedule stays under the cap in a 31-day month');
  assert.equal(istHour(Date.parse('2026-10-01T12:45:00Z')), 18);
  assert.equal(istMonth(Date.parse('2026-09-30T19:00:00Z')), '2026-10', 'after IST midnight it is October');
  const db = new DatabaseSync(':memory:');
  const store = createCrossCheckStore(db);
  store.record('omr-south', '2026-10-01T12:30:00.000Z', '2026-10-01T12:29:00.000Z', { outcome: 'within10', congestionAgree: 1, congestionRule: 2, legsWithin20: 6, legs: 6 });
  store.record('omr-south', '2026-10-01T13:30:00.000Z', '2026-10-01T13:29:00.000Z', { outcome: 'tomtom-higher', congestionAgree: 1, congestionRule: 2, legsWithin20: 3, legs: 6 });
  store.record('omr-south', '2026-10-01T11:30:00.000Z', '2026-10-01T11:29:00.000Z', { outcome: 'within10', congestionAgree: 0, legsWithin20: 6, legs: 6 }); // first rule: excluded from congestion
  store.record('omr-south', '2026-10-01T14:30:00.000Z', null, { outcome: 'error', error: 'HTTP 500' });
  const cols = db.prepare('PRAGMA table_info(crosscheck)').all().map((c) => c.name);
  assert.deepEqual(cols, ['corridor_id', 'ts', 'tomtom_ts', 'outcome', 'congestion_agree', 'legs_within20', 'legs', 'error', 'congestion_rule'], 'no column can hold a Google duration or distance');
  assert.equal(store.callsInMonth('2026-10'), 4);
  assert.equal(store.onlyErrorsAt('2026-10-01T14:30:00.000Z'), true);
  assert.equal(store.onlyErrorsAt('2026-10-01T12:30:00.000Z'), false);
  assert.equal(store.callsInMonth('2026-09'), 0);
  const [row] = store.summary('2026-10-01T00:00:00Z');
  assert.equal(row.compared, 3);
  assert.equal(row.errors, 1);
  assert.equal(row.congestion_known, 2, 'the first-rule row is left out');
  assert.equal(agreementText(row), 'within 10% of Google in 67% and within 20% in 67% of 3 checks; both put the road in the same state (heavy or not) 100% of the time; stretch by stretch, 83% within 20%');
  assert.equal(agreementText(null), 'no comparisons yet');
});
