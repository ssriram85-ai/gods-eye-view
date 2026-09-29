import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorridorStore } from '../src/corridor.mjs';
import { createTravelStore } from '../src/travel.mjs';
import { createIncidentStore, normalizeIncident } from '../src/incidents.mjs';
import { isoWeekKey, weekBounds, lastCompletedWeek, previousWeek, summarizeWeek, summarizeCity, headline, renderWeeklyHtml, renderWeeklyText } from '../src/weekly.mjs';

const DAY = 86_400_000;

test('ISO week keys and bounds follow IST calendar weeks', () => {
  const w = weekBounds('2026-W39');
  assert.equal(w.start, '2026-09-20T18:30:00.000Z');
  assert.equal(w.end, '2026-09-27T18:30:00.000Z');
  assert.equal(w.label, '2026-09-21 → 2026-09-27');
  assert.equal(isoWeekKey(Date.UTC(2026, 8, 21)), '2026-W39');
  assert.equal(isoWeekKey(Date.UTC(2026, 0, 5)), '2026-W02');
  assert.equal(weekBounds('2026-W99'), null);
  assert.equal(lastCompletedWeek(Date.parse('2026-09-28T01:30:00Z')).key, '2026-W39');
  assert.equal(lastCompletedWeek(Date.parse('2026-09-27T17:30:00Z')).key, '2026-W38');
  assert.equal(previousWeek(w).key, '2026-W38');
});

/** Two weeks of a three-section road: evening peak is 4 min worse in the second week. */
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-'));
  const corridors = createCorridorStore(join(dir, 'c.db'));
  const travel = createTravelStore(corridors.db);
  const incidents = createIncidentStore(corridors.db);
  const corridor = { id: 'omr-south', name: 'OMR southbound · Madhya Kailash → Siruseri', lengthKm: 22, definition: { road: 'omr', version: 2, sections: [{ from: 'Madhya Kailash', to: 'Perungudi', lengthKm: 6 }, { from: 'Perungudi', to: 'Sholinganallur', lengthKm: 8 }, { from: 'Sholinganallur', to: 'Siruseri', lengthKm: 8 }] } };
  const start = Date.parse(weekBounds('2026-W39').start) - 7 * DAY;
  for (let t = start; t < start + 14 * DAY; t += 30 * 60_000) {
    const local = new Date(t + 330 * 60_000);
    const min = local.getUTCHours() * 60 + local.getUTCMinutes();
    const weekday = local.getUTCDay() >= 1 && local.getUTCDay() <= 5;
    const second = t >= start + 7 * DAY;
    const evening = weekday && min >= 990 && min < 1230;
    const morning = weekday && min >= 450 && min < 630;
    const extra = [0, evening ? 10 + (second ? 4 : 0) : morning ? 5 : 0, evening ? 2 : 0];
    const rows = [10, 12, 14].map((free, i) => ({ leg: i, lengthM: 6000, travelS: (free + extra[i]) * 60, noTrafficS: free * 60, historicS: free * 60, incidentsS: null, delayS: extra[i] * 60, detour: 0 }));
    travel.save(corridor.id, { ts: new Date(t).toISOString(), rows, jams: evening ? [{ leg: 1, category: 'jam', magnitude: 3, delayS: 600, startKm: 9, endKm: 10, lat: 12.94, lon: 80.237 }] : [] });
  }
  const inc = (id, icon) => normalizeIncident({ geometry: { type: 'Point', coordinates: [80.2279, 12.901] }, properties: { id, iconCategory: icon, magnitudeOfDelay: 4, from: 'Sholinganallur', to: 'Karapakkam' } });
  incidents.record([inc('a1', 1), inc('j1', 6)], '2026-09-23T13:00:00.000Z');
  incidents.record([inc('a2', 1)], '2026-09-25T13:00:00.000Z');
  return { travel, incidents, corridor, week: weekBounds('2026-W39') };
}

test('a week is summarized by peak with the week before, tips and the jammed stretch', () => {
  const { travel, corridor, week } = seeded();
  const s = summarizeWeek({ travel, corridor, week });
  assert.equal(s.samples, 7 * 48);
  const eve = s.periods.find((p) => p.id === 'evening');
  const morn = s.periods.find((p) => p.id === 'morning');
  assert.equal(Math.round(eve.minutes), 36 + 14 + 2 - 0); // 36 free + 14 + 2
  assert.equal(Math.round(eve.previousMinutes), 48);
  assert.equal(Math.round(eve.changeMinutes), 4);
  assert.equal(Math.round(eve.freeMinutes), 36);
  assert.equal(eve.bottleneck.section, 'Perungudi → Sholinganallur');
  assert.equal(Math.round(morn.minutes), 41);
  assert.equal(s.mostJammed.section, 'Perungudi → Sholinganallur');
  assert.ok(s.tips.some((t) => t.kind === 'depart' && t.window === 'evening'), JSON.stringify(s.tips));
  assert.match(headline(s), /evening peak averaged 52 min for 22 km \(36 min on an empty road\)/);
  assert.match(headline(s), /\+4 min vs last week/);
});

test('city incidents and trouble spots, and the rendered email', () => {
  const { travel, incidents, corridor, week } = seeded();
  const s = summarizeWeek({ travel, corridor, week });
  const city = summarizeCity({ incidents, week });
  assert.equal(city.accidents, 2);
  assert.equal(city.hotspots[0].place, 'Sholinganallur → Karapakkam');
  const html = renderWeeklyHtml({ summaries: [s], city, notes: [{ at: '2026-09-24T02:30:00.000Z', text: 'U-turns closed' }], week, baseUrl: 'https://gev.example' });
  assert.match(html, /Chennai roads · week 2026-W39/);
  assert.match(html, /OMR \(Rajiv Gandhi Salai\)/);
  assert.match(html, /Evening peak/);
  assert.match(html, /\+4 min/);
  assert.match(html, /2 accident reports/);
  assert.match(html, /google\.com\/maps\?q=12\.901,80\.2279/);
  assert.match(html, /U-turns closed/);
  assert.doesNotMatch(html, /<svg/);
  const text = renderWeeklyText({ summaries: [s], city, week, baseUrl: 'https://gev.example' });
  assert.match(text, /Trouble spot: Sholinganallur → Karapakkam/);
  assert.match(text, /Live page: https:\/\/gev\.example\//);
});

test('an empty week renders without failing', () => {
  const { travel, corridor } = seeded();
  const s = summarizeWeek({ travel, corridor, week: weekBounds('2026-W45') });
  assert.equal(s.samples, 0);
  assert.match(headline(s), /no readings this week/);
  assert.match(renderWeeklyHtml({ summaries: [s], city: null, week: weekBounds('2026-W45') }), /Not enough days recorded/);
});
