import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorridorStore } from '../src/corridor.mjs';
import { createTravelStore } from '../src/travel.mjs';
import { createIncidentStore, normalizeIncident } from '../src/incidents.mjs';
import { isoWeekKey, weekBounds, lastCompletedWeek, previousWeek, summarizeWeek, summarizeCity, addCrossRoadNotes, headline, renderWeeklyHtml, renderWeeklyText } from '../src/weekly.mjs';

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
  const inc = (id, icon) => normalizeIncident({ geometry: { type: 'Point', coordinates: [80.2279, 12.901] }, properties: { id, iconCategory: icon, magnitudeOfDelay: 4, delay: 420, from: 'Sholinganallur', to: 'Karapakkam' } });
  incidents.record([inc('a1', 1), inc('j1', 6)], '2026-09-23T13:00:00.000Z');
  incidents.record([inc('a2', 1), inc('j2', 6)], '2026-09-25T13:00:00.000Z');
  return { travel, incidents, corridor, week: weekBounds('2026-W39') };
}

/** Two wet hours on Wednesday evening of week 39 (17:30–19:30 IST). */
const RAIN = new Map([['2026-09-23T12:00:00.000Z', 5], ['2026-09-23T13:00:00.000Z', 5], ['2026-09-23T14:00:00.000Z', 0]]);

test('a week is summarized inside rush windows found from all days, against the week before', () => {
  const { travel, corridor, week } = seeded();
  const s = summarizeWeek({ travel, corridor, week, rain: RAIN });
  assert.equal(s.samples, 7 * 48);
  assert.equal(s.confidence.level, 'established', '10 weekdays across the two weeks');
  assert.equal(s.source.kind, 'observed');
  assert.equal(Math.round(s.baselineMinutes), 36);
  const eve = s.periods.find((p) => p.period === 'evening');
  const morn = s.periods.find((p) => p.period === 'morning');
  assert.equal(eve.window, '16:30–20:30');
  assert.equal(Math.round(eve.typical), 52);
  assert.equal(Math.round(eve.previousTypical), 48);
  assert.equal(Math.round(eve.change), 4);
  assert.equal(morn.window, '07:30–10:30');
  assert.equal(Math.round(morn.typical), 41);
  assert.equal(Math.round(morn.change), 0);
  assert.ok(s.tips.some((t) => t.kind === 'shift' && t.period === 'evening' && /saves about 14 min/.test(t.text)), JSON.stringify(s.tips.map((t) => t.text)));
  assert.ok(s.tips.some((t) => t.kind === 'bottleneck' && /Perungudi → Sholinganallur carries 86%/.test(t.text)));
  assert.equal(s.rain.mm, 10);
  assert.equal(s.rain.wetHours, 2);
  assert.equal(s.rain.wetSamples, 4);
  assert.equal(Math.round(s.rain.excessMinutes), 2);
  assert.equal(s.mostJammed.section, 'Perungudi → Sholinganallur');
  assert.match(headline(s), /evening rush 16:30–20:30, worst around 16:30, typically 52 min \(52 min on a bad day\) for 22 km; 36 min at night; \+4 min on last week/);
});

test('city incidents: recurring jams and safety spots, and the rendered email', () => {
  const { travel, incidents, corridor, week } = seeded();
  const s = addCrossRoadNotes([summarizeWeek({ travel, corridor, week, rain: RAIN })])[0];
  s.formal = { ready: true, text: 'Ready for formal use.' };
  s.agreement = { compared: 40, within10: 34, within20: 39, congestion_agree: 36, congestion_known: 40, legs_within20: 0, legs_known: 0 };
  const city = summarizeCity({ incidents, week });
  assert.equal(city.accidents, 2);
  assert.equal(city.recurring.length, 1);
  assert.equal(city.recurring[0].days, 2);
  assert.equal(city.recurring[0].typicalDelayMinutes, 7);
  assert.equal(city.safety[0].kinds.accident, 2);
  const html = renderWeeklyHtml({ summaries: [s], city, notes: [{ at: '2026-09-24T02:30:00.000Z', text: 'U-turns closed' }], week, baseUrl: 'https://gev.example' });
  assert.match(html, /Chennai roads · week 2026-W39/);
  assert.match(html, /All road directions meet the bar for formal use: enough weekdays recorded and confirmed against Google/);
  assert.match(html, />Findings \(ready for formal use\)</);
  assert.match(html, /second source: within 10% of Google in 85% and within 20% in 98% of 40 checks/);
  assert.match(html, /checked hourly against Google's live-traffic routing for the same drive; Google's own times are not stored/);
  assert.match(html, /Varies day to day \(live\)/);
  assert.match(html, /Evening <span style="color:#888">16:30–20:30/);
  assert.match(html, /\+4 min/);
  assert.match(html, /rain 10 mm, 2 wet hours, wet-hour drives \+2 min vs typical/);
  assert.match(html, /2 accident reports/);
  assert.match(html, /Recurring jams, last 30 days/);
  assert.match(html, /google\.com\/maps\?q=12\.901,80\.2279/);
  assert.match(html, /2026-09-24 08:00: U-turns closed/);
  assert.match(html, /gev\.example\/methodology/);
  assert.doesNotMatch(html, /<svg/);
  const text = renderWeeklyText({ summaries: [s], city, week, baseUrl: 'https://gev.example' });
  assert.match(text, /\[varies day to day; established\]/);
  assert.match(text, /Recurring jam: Sholinganallur → Karapakkam \(2 days, typical delay 7 min\)/);
});

test('an empty week, and early data labelled as early', () => {
  const { travel, corridor } = seeded();
  const empty = summarizeWeek({ travel, corridor, week: weekBounds('2026-W45') });
  assert.equal(empty.samples, 0);
  assert.match(headline(empty), /no readings this week/);
  const first = summarizeWeek({ travel, corridor, week: weekBounds('2026-W38') });
  assert.equal(first.confidence.level, 'provisional', 'five weekdays recorded by the end of the first week');
  const html = renderWeeklyHtml({ summaries: [empty, first], city: null, week: weekBounds('2026-W38') });
  assert.match(html, /Observations, not yet for formal use: provisional: 5 weekdays recorded/);
  assert.match(html, /0 of 2 road directions meet the bar for formal use/);
});
