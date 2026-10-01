import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorridorStore } from '../src/corridor.mjs';
import { createTravelStore } from '../src/travel.mjs';
import { createRollupStore, daysToRoll, rollupCsv, istDayBounds } from '../src/rollup.mjs';
import { fetchRain, createWeatherStore, rainBand, rainAt } from '../src/weather.mjs';
import { renderMethodology } from '../src/methodology.mjs';

function seeded() {
  const corridors = createCorridorStore(join(mkdtempSync(join(tmpdir(), 'rollup-')), 'c.db'));
  const travel = createTravelStore(corridors.db);
  const corridor = { id: 'omr-south', name: 'OMR southbound · A → C', lengthKm: 10, definition: { road: 'omr', version: 2, sections: [{ from: 'A', to: 'B', lengthKm: 5 }, { from: 'B', to: 'C', lengthKm: 5 }] } };
  // Two IST days, every 15 minutes; 18:00–18:30 IST slot takes 20 + 10 min on day 1 and 24 + 10 on day 2.
  for (const day of ['2026-09-29', '2026-09-30'])
    for (let min = 0; min < 1440; min += 15) {
      const ts = new Date(Date.parse(`${day}T00:00:00+05:30`) + min * 60_000).toISOString();
      const peak = min >= 1080 && min < 1110 ? (day === '2026-09-29' ? 10 : 14) : 0;
      travel.save(corridor.id, { ts, rows: [{ leg: 0, travelS: (10 + peak) * 60, noTrafficS: 600, historicS: 600, delayS: 0, detour: 0 }, { leg: 1, travelS: 600, noTrafficS: 600, historicS: 600, delayS: 0, detour: 0 }], jams: [] });
    }
  return { corridors, travel, corridor, rollups: createRollupStore(corridors.db) };
}

test('IST day bounds and which days still need rolling up', () => {
  assert.deepEqual(istDayBounds('2026-09-30'), { start: '2026-09-29T18:30:00.000Z', end: '2026-09-30T18:30:00.000Z' });
  const now = Date.parse('2026-10-01T06:00:00Z'); // 11:30 IST on 1 Oct
  assert.deepEqual(daysToRoll({ firstTs: '2026-09-29T06:09:00Z', rolled: new Set(), now }), ['2026-09-29', '2026-09-30']);
  assert.deepEqual(daysToRoll({ firstTs: '2026-09-29T06:09:00Z', rolled: new Set(['2026-09-29', '2026-09-30']), now }), ['2026-09-30'], 'yesterday is always re-rolled');
  assert.deepEqual(daysToRoll({ firstTs: null, rolled: new Set(), now }), []);
});

test('a day rolls up into 30-minute slots with medians, ranges, rain, and exports as CSV', () => {
  const { travel, corridor, rollups } = seeded();
  const rain = new Map([['2026-09-29T12:00:00.000Z', 6.2]]); // 17:30–18:30 IST
  assert.equal(rollups.rollDay({ corridor, day: '2026-09-29', travel, rain }), 48);
  rollups.rollDay({ corridor, day: '2026-09-30', travel, rain: null });
  const rows = rollups.rows('2026-09-29', '2026-09-30');
  assert.equal(rows.length, 96);
  const six = rows.find((r) => r.day === '2026-09-29' && r.slot === 1080);
  assert.equal(six.samples, 2);
  assert.equal(six.median_min, 30);
  assert.equal(six.observed_share, 1);
  assert.equal(six.rain_mm, 6.2);
  assert.deepEqual(JSON.parse(six.section_median_min), [20, 10]);
  const csv = rollupCsv(rows, new Map([[corridor.id, corridor]]));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 97);
  assert.match(lines[0], /^corridor_id,corridor,length_km,day_ist,weekday,departure_slot_ist,samples,median_min/);
  assert.ok(lines.includes('omr-south,OMR southbound · A → C,10,2026-09-29,Tue,18:00,2,30,30,30,20,20,1,6.2,"[20,10]"'), lines.find((l) => l.includes(',18:00,')));
  assert.deepEqual(rollups.days(corridor.id), ['2026-09-29', '2026-09-30']);
});

test('raw retention deletes only rolled-up days older than the limit', () => {
  const { travel, corridor, rollups, corridors } = seeded();
  rollups.rollDay({ corridor, day: '2026-09-29', travel });
  assert.deepEqual(rollups.purgeRaw(0, [corridor.id]), { deleted: 0 }, 'off by default');
  const result = rollups.purgeRaw(1, [corridor.id]);
  assert.equal(result.deleted, 96 * 2, 'day 1 deleted: rolled up and older than a day');
  const left = corridors.db.prepare('SELECT COUNT(*) AS n FROM route_samples').get().n;
  assert.equal(left, 96 * 2, 'day 2 kept: never rolled up');
});

test('rain is fetched for every road point, recorded, and looked up by hour', async () => {
  const body = ['omr', 'anna-salai', 'gst', 'ecr'].map((_, i) => ({ hourly: { time: ['2026-09-28T19:00', '2026-09-28T20:00', '2999-01-01T00:00'], precipitation: [3.5 + i, 0, 9] } }));
  let asked = '';
  const rows = await fetchRain({ fetchImpl: async (url) => ((asked = url), { ok: true, json: async () => body }) });
  assert.match(asked, /latitude=12\.93%2C13\.035%2C12\.955%2C12\.925/);
  assert.match(asked, /hourly=precipitation/);
  assert.equal(rows.length, 8, 'future hours dropped');
  assert.deepEqual(rows[0], { point: 'omr', hour: '2026-09-28T19:00:00.000Z', mm: 3.5 });
  const { corridors } = seeded();
  const store = createWeatherStore(corridors.db);
  store.record(rows);
  store.record([{ point: 'omr', hour: '2026-09-28T19:00:00.000Z', mm: 4 }]);
  const series = store.series('omr', '2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z');
  assert.equal(series.get('2026-09-28T19:00:00.000Z'), 4, 'a later poll corrects the hour');
  assert.equal(rainAt(series, '2026-09-28T19:45:00.000Z'), 4);
  assert.equal(rainAt(series, '2026-09-28T23:45:00.000Z'), null);
  assert.deepEqual(['dry', 'drizzle', 'light', 'moderate', 'heavy'], [0, 1, 3, 8, 20].map(rainBand));
});

test('the methodology page states definitions, per-road status and limits from live numbers', () => {
  const corridor = { id: 'ecr-south', name: 'ECR southbound · Thiruvanmiyur → Uthandi', lengthKm: 13.2, definition: { sections: [{}, {}, {}, {}, {}] } };
  const html = renderMethodology({
    roads: [{ corridor, since: '2026-09-29T06:09:00Z', days: { weekdays: 3, weekendDays: 0 }, source: { kind: 'modelled', share: 0.02 }, confidence: { level: 'early' } }],
    incidentCounts: [{ category: 'road closed', n: 175 }, { category: 'jam', n: 116 }],
    incidentsSince: '2026-09-29T06:09:33Z',
    rainSince: '2026-09-26T00:00:00Z',
    notes: [{ at: '2026-10-18T18:30:00.000Z', text: 'Public holiday: Ayudha Pooja' }],
  });
  assert.match(html, /How these numbers are made/);
  assert.match(html, /Mostly TomTom's pattern<div class="muted">2% of half-hours differ by 3\+ min/);
  assert.match(html, /The check<\/b> is being connected; until it is, every figure rests on TomTom alone/);
  assert.match(html, /Not yet: needs many more weekdays recorded; needs 50 more Google checks\./);
  assert.match(html, />early</);
  assert.match(html, /Night-time drive/);
  assert.match(html, /at least 6 minutes/);
  assert.match(html, /reports 175 road closed, 116 jam\. Accident locations need official records/);
  assert.match(html, /Raw readings are currently kept while that limit is confirmed with TomTom/);
  assert.match(html, /available on request while TomTom confirms its sharing terms/);
  assert.match(html, /section 19\.3\) allow caching only latitude and longitude/);
  assert.match(html, /2026-10-19 00:00<\/td><td>Public holiday: Ayudha Pooja/);
});

test('with Google connected the page shows the schedule, agreement and which roads are fit for formal use', () => {
  const road = (id, level, weekdays) => ({ corridor: { id, name: id, lengthKm: 20, definition: { sections: [{}, {}] } }, since: '2026-09-29T06:09:00Z', days: { weekdays, weekendDays: 4 }, source: { kind: 'observed', share: 0.2 }, confidence: { level } });
  const html = renderMethodology({
    roads: [road('omr-south', 'established', 12), road('ecr-north', 'established', 12)],
    crosscheck: {
      configured: true, hours: new Set([3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]), cap: 4800,
      rows: [
        { corridor_id: 'omr-south', compared: 60, within10: 48, within20: 57, congestion_agree: 54, congestion_known: 60, legs_within20: 300, legs_known: 360, route_differs: 2, errors: 0 },
        { corridor_id: 'ecr-north', compared: 60, within10: 30, within20: 40, congestion_agree: 50, congestion_known: 60, legs_within20: 200, legs_known: 300, route_differs: 0, errors: 1 },
      ],
    },
  });
  assert.match(html, /The check<\/b> is Google's live-traffic drive for the same road at the same moment, 03:00 and every hour from 06:00 to 23:00 \(IST\)\. So far TomTom's time has been within 10% of Google's in 65% of 120 checks, and within 20% in 81%\./);
  assert.match(html, /Fit for a formal submission<\/b> today: 1 of 2 road directions/);
  assert.match(html, /within 10% of Google in 80% and within 20% in 95% of 60 checks/);
  assert.match(html, /2 check\(s\) left out: Google's route differed/);
  assert.match(html, /<td><b>Yes<\/b><\/td>/);
  assert.match(html, /Not yet: Google agreement within 20% is 67%, below 80%\./);
  assert.match(html, /03:00 and every hour from 06:00 to 23:00 \(IST\), straight after a TomTom reading/);
});
