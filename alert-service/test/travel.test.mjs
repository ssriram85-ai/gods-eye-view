import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { corridorDefinitions, resolveSections, sampleSections, createTravelStore, trimEndLoops, ROADS } from '../src/travel.mjs';
import { createCorridorStore } from '../src/corridor.mjs';
import { travelProfile, commuterTips, liveStatus, istSlot, dayType, crossRoadNotes, confidenceOf, sourceOf, nextCommute, rushShapes, nightBaseline } from '../src/insights.mjs';

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
      const legs = [3, 4, 3].map((free, i) => ({ leg: i, lengthM: 3000, travelS: (free + (evening && i === 1 ? 12 : evening ? 2 : lateMorning ? [1, 4, 1][i] : 0)) * 60, noTrafficS: free * 60, historicS: free * 60, incidentsS: null, delayS: 0, detour: 0 }));
      travel.save(corridor.id, { ts, rows: legs, jams: evening ? [{ leg: 1, category: 'jam', magnitude: 3, delayS: 600, startKm: 5, endKm: 6, lat: 12.95, lon: 80.25 }] : [] });
    }
  }
  return { travel, corridor };
}

test('rush shape, realistic shifts, the stretch that carries the delay, and live status', () => {
  const { travel, corridor } = recorded();
  const rows = travel.rows(corridor.id, '2026-09-27T00:00:00Z', '2026-10-01T00:00:00Z');
  assert.equal(istSlot('2026-09-29T12:45:00Z'), 18 * 60);
  assert.equal(dayType('2026-09-27T06:00:00Z'), 'weekend');
  const prof = travelProfile(rows, { sections: 3 });
  assert.equal(prof.weekday.length, 48);
  const six = prof.weekday.find((s) => s.label === '18:00');
  assert.equal(six.days, 2);
  assert.equal(Math.round(six.minutes), 26); // 10 at night + 12 + 2 + 2
  assert.equal(six.observedShare, 1, 'live differs from the (flat) historic time by more than 2 min');
  assert.equal(Math.round(nightBaseline(prof.weekday).minutes), 10);
  const { tips, rushes, enoughData, baseline } = commuterTips(corridor, prof);
  assert.equal(enoughData, true);
  assert.equal(Math.round(baseline.minutes), 10);
  const eve = rushes.find((r) => r.period === 'evening');
  assert.deepEqual([eve.startLabel, eve.peak.label, eve.endLabel], ['18:00', '18:00', '20:00']);
  const text = tips.map((t) => t.text).join('\n');
  assert.match(text, /Evening rush: builds from 18:00, worst at 18:00 \(about 26 min\), eases by 20:00\. The same drive takes 10 min at night\./);
  assert.match(text, /Leaving at 17:00 instead of 18:00 saves about 16 min \(10 vs 26\)/);
  assert.match(text, /At 18:00, B → C carries 75% of the extra time: 16 min for 4\.4 km/);
  assert.match(text, /Morning rush: builds from 08:30, worst at 08:30 \(about 16 min\), eases by 10:00/);
  assert.match(text, /At 08:30, B → C carries 67% of the extra time/);
  assert.doesNotMatch(text, /07:00|21:00|16:00/, 'no window edge can become advice');
  const status = liveStatus(corridor, travel.latest(corridor.id), prof, baseline);
  assert.equal(status.level, 'clear');
  assert.equal(status.usualSource, 'recorded');
  assert.equal(status.nightSource, 'recorded');
  assert.equal(status.unusual, false);
  assert.equal(Math.round(status.minutes), 10);
});

test('no quick win and a spread-out delay are said plainly', () => {
  // Synthetic weekday profile: a broad evening rush, three equal stretches, no slot an hour away much better.
  const slot = (h, m, minutes, legs) => ({ slot: h * 60 + m, label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, days: 3, samples: 6, minutes, p10: minutes - 2, p90: minutes + 3, sectionMinutes: legs, observedShare: 0.4 });
  const weekday = [];
  for (let t = 0; t < 24 * 60; t += 30) {
    const h = Math.floor(t / 60), m = t % 60;
    const busy = t >= 15 * 60 && t < 22 * 60;
    const peak = t === 18 * 60 + 30 ? 4 : t === 18 * 60 || t === 19 * 60 ? 2 : 0;
    const extra = busy ? 9 + peak : 0;
    weekday.push(slot(h, m, 30 + extra, [10 + extra / 3, 10 + extra / 3, 10 + extra / 3]));
  }
  const corridor = { definition: { sections: [{ from: 'A', to: 'B', lengthKm: 3 }, { from: 'B', to: 'C', lengthKm: 3 }, { from: 'C', to: 'D', lengthKm: 3 }] } };
  const { tips } = commuterTips(corridor, { weekday, weekend: [] });
  const text = tips.map((t) => t.text).join('\n');
  assert.match(text, /Evening rush: builds from 15:00, worst at 18:30 \(about 43 min, 41–46 on most days\), eases by 22:00/);
  assert.match(text, /No quick win around 18:30: leaving up to an hour earlier or later saves at most 4 min/);
  assert.match(text, /At 18:30 the delay is spread along the road/);
  assert.match(text, /Morning: no real rush/);
});

test('confidence, source labels, next commute and cross-road notes', () => {
  assert.equal(confidenceOf(3).level, 'early');
  assert.equal(confidenceOf(5).level, 'provisional');
  assert.equal(confidenceOf(10).level, 'established');
  // Same half-hour (10:00 IST) on two weekdays: identical drives look like a pattern, 5 minutes apart looks live.
  const at = (day, min) => new Date(Date.parse(`${day}T10:00:00+05:30`) + min * 60_000).toISOString();
  const day = (d, minutes) => [0, 15].map((m) => ({ ts: at(d, m), leg: 0, travel_s: minutes * 60, historic_s: 1800 }));
  assert.equal(sourceOf([...day('2026-09-29', 30), ...day('2026-09-30', 30.5)], 1).kind, 'modelled');
  const live = sourceOf([...day('2026-09-29', 30), ...day('2026-09-30', 35)], 1);
  assert.equal(live.kind, 'observed');
  assert.match(live.text, /varies day to day \(live\): in 100% of half-hour slots the drive differed between weekdays by 3 minutes or more/);
  assert.equal(sourceOf(day('2026-09-29', 30), 1).kind, 'unknown', 'one weekday is not enough');
  assert.equal(nextCommute('2026-10-01T04:00:00Z'), 'morning'); // 09:30 IST
  assert.equal(nextCommute('2026-10-01T09:00:00Z'), 'evening'); // 14:30 IST
  assert.equal(nextCommute('2026-10-01T17:00:00Z'), 'morning'); // 22:30 IST
  const rush = (period, h, minutes) => ({ period, peak: { slot: h * 60, label: `${h}:00`, minutes } });
  const road = (id, road, direction, rushes) => ({ corridor: { id, name: id, definition: { road, direction } }, rushes });
  const notes = crossRoadNotes([
    road('a-n', 'a', 'northbound', [rush('morning', 10, 40), rush('evening', 19, 38)]),
    road('a-s', 'a', 'southbound', [rush('morning', 9, 30), rush('evening', 18, 49)]),
    road('b-n', 'b', 'northbound', [rush('evening', 17, 64)]),
    road('b-s', 'b', 'southbound', [rush('evening', 18, 64)]),
  ]);
  assert.deepEqual(notes.get('a-n'), ['Unlike most monitored roads, its worst rush is in the morning (10:00).']);
  assert.deepEqual(notes.get('b-n'), ["Its evening peak comes an hour before the southbound direction's."]);
  assert.deepEqual(notes.get('a-s'), ["Its morning peak comes an hour before the northbound direction's.", "Its evening peak comes an hour before the northbound direction's."]);
  assert.equal(rushShapes([], null).length, 0);
});

test('advice waits for two days of data', () => {
  const { travel, corridor } = recorded();
  const oneDay = travel.rows(corridor.id, '2026-09-28T00:00:00Z', '2026-09-28T18:30:00Z');
  const { tips, enoughData } = commuterTips(corridor, travelProfile(oneDay, { sections: 3 }));
  assert.equal(enoughData, false);
  assert.equal(tips.length, 0);
});

test('a road busy all day is described as one busy period with two peaks and a midday low', () => {
  // Shaped like OMR southbound: 36 min at night, morning peak 56 at 09:30, midday low 47 at 14:00, evening peak 63 at 18:30.
  const at = (t) => {
    const h = t / 60;
    if (h < 7 || h >= 22) return 36;
    if (h < 9.5) return 36 + (h - 7) * 8; // up to 56
    if (h < 14) return 56 - (h - 9.5) * 2; // down to 47
    if (h < 18.5) return 47 + (h - 14) * (16 / 4.5); // up to 63
    return 63 - (h - 18.5) * (27 / 3.5); // down to 36 by 22:00
  };
  const weekday = [];
  for (let t = 0; t < 1440; t += 30) {
    const minutes = at(t);
    weekday.push({ slot: t, label: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, days: 3, samples: 6, minutes, p10: minutes - 2, p90: minutes + 3, sectionMinutes: [minutes / 2, minutes / 2], observedShare: 0.3 });
  }
  const corridor = { definition: { sections: [{ from: 'A', to: 'B', lengthKm: 11 }, { from: 'B', to: 'C', lengthKm: 11 }] } };
  const { tips, rushes } = commuterTips(corridor, { weekday, weekend: [] });
  assert.ok(rushes.every((r) => r.continuous), 'midday low stays above both thresholds');
  const text = tips.map((t) => t.text).join('\n');
  assert.match(text, /Morning peak at 09:30 \(about 56 min, 54–59 on most days\)\. The road is busy from 08:00 to 21:00 and between the peaks eases only to 47 min \(14:00\); at night the drive takes 36 min\./);
  assert.match(text, /Evening peak at 18:30 \(about 63 min, 61–66 on most days\)/);
  assert.doesNotMatch(text, /eases by 00:00|builds from 07:30/);
});
