import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorridorStore } from '../src/corridor.mjs';
import { isoWeekKey, weekBounds, lastCompletedWeek, summarizeWeek, headline, renderWeeklyHtml, renderWeeklyText, PERIODS } from '../src/weekly.mjs';

const IST = 330 * 60_000;
const DAY = 86_400_000;

test('ISO week keys and bounds follow IST calendar weeks', () => {
  // 2026-09-24 is a Thursday in ISO week 39; that week runs Mon 21 → Sun 27 Sep.
  const w = weekBounds('2026-W39');
  assert.equal(w.start, '2026-09-20T18:30:00.000Z'); // Monday 00:00 IST
  assert.equal(w.end, '2026-09-27T18:30:00.000Z');
  assert.equal(w.label, '2026-09-21 → 2026-09-27');
  assert.equal(isoWeekKey(Date.UTC(2026, 8, 21)), '2026-W39');
  assert.equal(isoWeekKey(Date.UTC(2026, 0, 5)), '2026-W02');
  assert.equal(weekBounds('2026-W99'), null);
  // Asked on Monday 28 Sep 07:00 IST, the last completed week is W39.
  assert.equal(lastCompletedWeek(Date.parse('2026-09-28T01:30:00Z')).key, '2026-W39');
  // Asked on Sunday 27 Sep 23:00 IST, W39 has not ended: W38.
  assert.equal(lastCompletedWeek(Date.parse('2026-09-27T17:30:00Z')).key, '2026-W38');
});

/** Fill a store: baseline week at ratio 0.8 all day, report week slower in the evening only. */
function seeded() {
  const store = createCorridorStore(join(mkdtempSync(join(tmpdir(), 'weekly-')), 'c.db'));
  const corridor = store.saveCorridor({ id: 'omr-south', name: 'OMR southbound', definition: {}, points: [{}, {}], lengthKm: 20, routeTravelTimeS: 1500 });
  const week = weekBounds('2026-W39');
  const start = Date.parse(week.start) - 7 * DAY; // one baseline week before
  for (let t = start; t < Date.parse(week.end); t += 30 * 60_000) {
    const local = (t + IST) % DAY;
    const evening = local >= 990 * 60_000 && local < 1230 * 60_000;
    const inWeek = t >= Date.parse(week.start);
    const ratio = inWeek && evening ? 0.5 : 0.8;
    const rows = [0, 1].map((i) => ({ pointIndex: i, currentSpeed: 60 * ratio, freeFlowSpeed: 60, currentTravelTime: 600 / ratio, freeFlowTravelTime: 600, confidence: 0.9, roadClosure: false, frc: 'FRC2' }));
    store.saveSamples(corridor.id, { ts: new Date(t).toISOString(), rows });
  }
  store.addNote(corridor.id, '2026-09-23T04:00:00.000Z', 'U-turns closed');
  return { store, corridor, week };
}

test('a week is summarized by period and day against the earlier baseline', () => {
  const { store, corridor, week } = seeded();
  const s = summarizeWeek({ store, corridor, week });
  assert.equal(s.samples, 7 * 48);
  assert.ok(s.coverage > 0.49 && s.coverage < 0.51, `coverage ${s.coverage}`);
  assert.equal(s.baseline.samples, 7 * 48);
  const by = Object.fromEntries(s.periods.map((p) => [p.id, p]));
  assert.equal(Math.round(by.evening.speedRatio * 100), 50);
  assert.equal(Math.round(by.evening.baselineRatio * 100), 80);
  assert.equal(by.evening.changePoints, -30);
  assert.equal(by.morning.changePoints, 0);
  assert.equal(Math.round(by.evening.travelTimeS), 2400); // 2 points × 600 s / 0.5
  assert.equal(s.worstSlot.change.toFixed(2), '-0.30');
  assert.ok(s.worstSlot.label >= '16:30' && s.worstSlot.label < '20:30', s.worstSlot.label);
  assert.equal(s.days.length, 7);
  assert.ok(s.days.every((d) => d.samples === 48));
  assert.equal(s.notes.length, 1);
  assert.equal(PERIODS.length, 4);
  assert.match(headline(s), /evening peak ran at 50% of free-flow speed \(40\.0 min over 20 km\)/);
  assert.match(headline(s), /slower than the baseline/);
});

test('an empty week and a first week without baseline still render', () => {
  const { store, corridor } = seeded();
  const empty = summarizeWeek({ store, corridor, week: weekBounds('2026-W45') });
  assert.equal(empty.samples, 0);
  assert.match(headline(empty), /No readings/);
  const first = summarizeWeek({ store, corridor, week: weekBounds('2026-W38') });
  assert.equal(first.baseline, null);
  assert.equal(first.periods[0].changePoints, null);
  assert.match(headline(first), /no earlier weeks yet/);
  const html = renderWeeklyHtml({ summaries: [empty, first], week: weekBounds('2026-W38'), baseUrl: 'https://x.example' });
  assert.match(html, /<table/);
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /https:\/\/x\.example\/corridors\/omr-south\/report\?hours=168/);
});

test('HTML and text reports carry the numbers and the live link with the comparison windows', () => {
  const { store, corridor, week } = seeded();
  const s = summarizeWeek({ store, corridor, week });
  const html = renderWeeklyHtml({ summaries: [s], week, baseUrl: 'https://gev.example' });
  assert.match(html, /Evening peak/);
  assert.match(html, />-30</);
  assert.match(html, /a=2026-09-14\.\.2026-09-20&amp;b=2026-09-21\.\.2026-09-27/);
  assert.match(html, /U-turns closed/);
  const text = renderWeeklyText({ summaries: [s], week, baseUrl: 'https://gev.example' });
  assert.match(text, /Evening peak 16:30–20:30: 50% this week vs 80% baseline \(-30\)/);
});
