import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { corridorDefinitions, resolveSections, sampleSections, createTravelStore, trimEndLoops, ROADS } from '../src/travel.mjs';
import { createCorridorStore } from '../src/corridor.mjs';
import { travelProfile, commuterTips, liveStatus, istSlot, dayType } from '../src/insights.mjs';

// A straight road running south from 13.00 to 12.90 (about 11 km), 101 points.
const ROAD = Array.from({ length: 101 }, (_, i) => ({ latitude: 13.0 - i * 0.001, longitude: 80.25 }));
const STOPS = [
  { name: 'A', lat: 13.0, lon: 80.2503 },
  { name: 'B', lat: 12.97, lon: 80.2497 }, // off the road by ~30 m, snaps to index 30
  { name: 'C', lat: 12.93, lon: 80.25 },
  { name: 'D', lat: 12.9, lon: 80.25 },
];
const def = { id: 'test-road', road: 'test', name: 'Test road southbound · A → D', stops: STOPS };

function fakeTomTom({ legMinutes = [5, 6, 4], freeMinutes = [3, 4, 3], jam = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (/traffic=false/.test(url)) return { ok: true, json: async () => ({ routes: [{ summary: { lengthInMeters: 11_100 }, legs: [{ points: ROAD }] }] }) };
    // Live sample: three legs split at the waypoints (indices 0, 30, 70, 100).
    const cuts = [0, 30, 70, 100];
    const legs = [0, 1, 2].map((i) => ({
      summary: { lengthInMeters: (cuts[i + 1] - cuts[i]) * 111, travelTimeInSeconds: legMinutes[i] * 60, noTrafficTravelTimeInSeconds: freeMinutes[i] * 60, historicTrafficTravelTimeInSeconds: (legMinutes[i] + 1) * 60, liveTrafficIncidentsTravelTimeInSeconds: legMinutes[i] * 60, trafficDelayInSeconds: (legMinutes[i] - freeMinutes[i]) * 60 },
      points: ROAD.slice(cuts[i], cuts[i + 1] + (i === 2 ? 1 : 0)),
    }));
    const sections = jam ? [{ sectionType: 'TRAFFIC', simpleCategory: 'JAM', magnitudeOfDelay: 3, delayInSeconds: 240, startPointIndex: 40, endPointIndex: 50 }] : [];
    return { ok: true, json: async () => ({ routes: [{ summary: { lengthInMeters: 11_100 }, legs, sections }] }) };
  };
  return { fetchImpl, calls };
}

test('every road is defined in both directions with unique ids', () => {
  const defs = corridorDefinitions();
  assert.equal(defs.length, ROADS.length * 2);
  assert.equal(new Set(defs.map((d) => d.id)).size, defs.length);
  const omr = defs.find((d) => d.id === 'omr-north');
  assert.equal(omr.stops[0].name, 'Siruseri');
  assert.match(omr.name, /^OMR northbound · Siruseri → Madhya Kailash$/);
});

test('resolving snaps named stops onto the road in order and names the sections', async () => {
  const { fetchImpl, calls } = fakeTomTom();
  const c = await resolveSections(def, { key: 'k', fetchImpl });
  assert.equal(calls.length, 1, 'one no-traffic route from the first to the last stop');
  assert.match(calls[0], /13\.000000,80\.250300:12\.900000,80\.250000/);
  assert.deepEqual(c.points.map((p) => p.name), ['A', 'B', 'C', 'D']);
  assert.equal(c.points[1].lat, 12.97);
  assert.equal(c.points[1].lon, 80.25, 'B snapped onto the road');
  assert.deepEqual(c.definition.sections.map((s) => `${s.from}-${s.to}`), ['A-B', 'B-C', 'C-D']);
  assert.ok(Math.abs(c.definition.sections[0].lengthKm - 3.34) < 0.05, `A-B ${c.definition.sections[0].lengthKm}`);
  assert.ok(Math.abs(c.lengthKm - 11.12) < 0.05);
  assert.equal(c.definition.version, 2);
  assert.deepEqual(c.definition.warnings, []);
  assert.ok(c.definition.line.length >= 2);
});

test('a start on the far carriageway loses its U-turn loop', () => {
  // Drive 1 km north, U-turn, come back past the start, then 5 km south.
  const loop = [
    ...Array.from({ length: 10 }, (_, i) => ({ lat: 13.0 + i * 0.001, lon: 80.2501 })),
    ...Array.from({ length: 10 }, (_, i) => ({ lat: 13.009 - i * 0.001, lon: 80.2499 })),
    ...Array.from({ length: 50 }, (_, i) => ({ lat: 12.999 - i * 0.001, lon: 80.2499 })),
  ];
  const trimmed = trimEndLoops(loop, { lat: 13.0, lon: 80.25 }, { lat: 12.95, lon: 80.25 });
  assert.ok(trimmed[1].lat < trimmed[0].lat, 'trimmed path heads south from its first point');
  assert.ok(trimmed.length < loop.length - 15);
});

test('a live sample records minutes per section, jams by section, and flags detours', async () => {
  const { fetchImpl } = fakeTomTom({ jam: true });
  const c = await resolveSections(def, { key: 'k', fetchImpl });
  const s = await sampleSections(c, { key: 'k', fetchImpl, now: () => Date.parse('2026-09-29T12:07:30Z') });
  assert.equal(s.ts, '2026-09-29T12:07:00.000Z');
  assert.deepEqual(s.rows.map((r) => r.travelS), [300, 360, 240]);
  assert.deepEqual(s.rows.map((r) => r.noTrafficS), [180, 240, 180]);
  assert.equal(s.detour, 0);
  assert.equal(s.jams.length, 1);
  assert.equal(s.jams[0].leg, 1, 'jam between points 40 and 50 is in section B → C');
  assert.equal(s.jams[0].category, 'jam');
  const long = await sampleSections({ ...c, lengthKm: 8 }, { key: 'k', fetchImpl });
  assert.equal(long.detour, 1);
});

/** A store filled with two weekdays: slow 18:00–20:00 IST, fast otherwise; 08:00 slower than 07:00. */
function recorded() {
  const db = createCorridorStore(join(mkdtempSync(join(tmpdir(), 'travel-')), 'c.db'));
  const travel = createTravelStore(db.db);
  const corridor = { id: 'test-road', name: def.name, lengthKm: 11.1, definition: { road: 'test', version: 2, sections: [{ from: 'A', to: 'B', lengthKm: 3.3 }, { from: 'B', to: 'C', lengthKm: 4.4 }, { from: 'C', to: 'D', lengthKm: 3.3 }] } };
  for (const day of ['2026-09-28', '2026-09-29']) {
    for (let min = 0; min < 24 * 60; min += 15) {
      const ts = new Date(Date.parse(`${day}T00:00:00+05:30`) + min * 60_000).toISOString();
      const h = min / 60;
      const evening = h >= 18 && h < 20, lateMorning = h >= 8.5 && h < 10;
      const legs = [3, 4, 3].map((free, i) => ({ leg: i, lengthM: 3000, travelS: (free + (evening && i === 1 ? 12 : evening ? 2 : lateMorning ? 3 : 0)) * 60, noTrafficS: free * 60, historicS: free * 60, incidentsS: null, delayS: 0, detour: 0 }));
      travel.save(corridor.id, { ts, rows: legs, jams: evening ? [{ leg: 1, category: 'jam', magnitude: 3, delayS: 600, startKm: 5, endKm: 6, lat: 12.95, lon: 80.25 }] : [] });
    }
  }
  return { travel, corridor };
}

test('profiles, tips and live status turn samples into advice', () => {
  const { travel, corridor } = recorded();
  const rows = travel.rows(corridor.id, '2026-09-27T00:00:00Z', '2026-10-01T00:00:00Z');
  assert.equal(istSlot('2026-09-29T12:45:00Z'), 18 * 60);
  assert.equal(dayType('2026-09-27T06:00:00Z'), 'weekend');
  const prof = travelProfile(rows, { sections: 3 });
  assert.equal(prof.weekday.length, 48);
  assert.equal(prof.weekend.length, 0);
  const six = prof.weekday.find((s) => s.label === '18:00');
  assert.equal(six.days, 2);
  assert.equal(Math.round(six.minutes), 26); // 10 free + 12 + 2 + 2
  assert.equal(Math.round(six.freeMinutes), 10);
  const { tips, enoughData } = commuterTips(corridor, prof);
  assert.equal(enoughData, true);
  const text = tips.map((t) => t.text).join('\n');
  assert.match(text, /Worst weekday time: leaving at 18:00 takes about 26 min, against 10 min on an empty road/);
  assert.match(text, /In the evening, leaving at 16:00 instead of 18:00 saves about 16 min/);
  assert.match(text, /In the morning, leaving at 07:00 instead of 08:30 saves about 9 min/);
  assert.match(text, /slowest stretch is B → C: 16 min for 4.4 km, 12 of the 16 extra minutes/);
  const status = liveStatus(corridor, travel.latest(corridor.id), prof);
  assert.equal(status.level, 'clear');
  assert.equal(status.usualSource, 'recorded');
  assert.equal(Math.round(status.minutes), 10);
});

test('advice waits for two days of data', () => {
  const { travel, corridor } = recorded();
  const oneDay = travel.rows(corridor.id, '2026-09-28T00:00:00Z', '2026-09-28T18:30:00Z');
  const { tips, enoughData } = commuterTips(corridor, travelProfile(oneDay, { sections: 3 }));
  assert.equal(enoughData, false);
  assert.equal(tips.length, 0);
});
