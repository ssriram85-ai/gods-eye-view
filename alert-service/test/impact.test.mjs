import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTravelStore } from '../src/travel.mjs';
import { evaluateChange, impactText, createInterventionStore, controlsFor, MIN } from '../src/impact.mjs';

const DAY = 86_400_000;
const road = (id, roadName) => ({ id, name: id, definition: { road: roadName, sections: [{}, {}] } });
const A = road('omr-south', 'omr'), A2 = road('omr-north', 'omr');
const C = [road('gst-south', 'gst'), road('gst-north', 'gst'), road('ecr-south', 'ecr'), road('anna-salai-north', 'anna-salai')];
const START = Date.parse('2026-10-15T00:00:00+05:30');

/**
 * Twenty days of readings every 15 min for every road. Each road has its own
 * daily shape and day-to-day noise; one rainy day (day 17) slows every road
 * by 25%. From START the changed road is `effect` slower (or faster).
 */
function seeded(effect) {
  const travel = createTravelStore(new DatabaseSync(':memory:'));
  let s = 42;
  const noise = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.06;
  const first = START - 14 * DAY;
  for (let t = first; t < START + 6 * DAY; t += 900_000) {
    const local = ((t + 330 * 60_000) % DAY) / 3_600_000;
    const rush = 1 + 0.5 * Math.exp(-((local - 9.5) ** 2) / 3) + 0.6 * Math.exp(-((local - 18.5) ** 2) / 4);
    const rain = Math.floor((t - first) / DAY) === 17 ? 1.25 : 1;
    for (const [k, c] of [A, A2, ...C].entries()) {
      const base = 20 + k * 3;
      const change = (c === A || c === A2) && t >= START ? 1 + effect : 1;
      const minutes = base * rush * rain * change * (1 + noise());
      travel.save(c.id, { ts: new Date(t).toISOString(), rows: [{ leg: 0, travelS: minutes * 30, noTrafficS: base * 30 }, { leg: 1, travelS: minutes * 30, noTrafficS: base * 30 }], jams: [] });
    }
  }
  return travel;
}

test('a real 10% slowdown is found, with a range that excludes zero, despite a citywide rainy day', () => {
  const travel = seeded(0.1);
  const r = evaluateChange({ travel, treated: A, controls: controlsFor(A, [A, A2, ...C]), start: new Date(START).toISOString(), now: START + 6 * DAY });
  assert.equal(r.status, 'significant', JSON.stringify(r));
  assert.ok(Math.abs(r.effectPct - 0.1) < 0.02, `effect ${r.effectPct}`);
  assert.ok(r.ciPct[0] > 0 && r.ciPct[1] < 0.2, `range ${r.ciPct}`);
  assert.equal(r.window.preDays, 14);
  assert.equal(r.window.postDays, 6);
  assert.deepEqual(r.controls, ['gst-south', 'gst-north', 'ecr-south', 'anna-salai-north'], 'the other direction of the same road is not a control');
  assert.equal(r.placebo.runs, 4);
  assert.equal(r.placebo.asLarge, 0);
  assert.match(impactText(r), /^omr-south, relative to the other monitored roads: slower: \+10% \(about \d+ min longer per drive\), 95% range \+\d+% to \+\d+%\. 14 days before, 6 after\. Placebo check: 0 of 4 untouched roads moved as much\.$/);
});

test('no change gives "no clear change", and a 15% improvement is found as faster', () => {
  const none = evaluateChange({ travel: seeded(0), treated: A, controls: controlsFor(A, [A, A2, ...C]), start: new Date(START).toISOString(), now: START + 6 * DAY });
  assert.equal(none.status, 'not-significant');
  assert.ok(none.ciPct[0] < 0 && none.ciPct[1] > 0);
  assert.match(impactText(none), /no clear change: [+−]\d+%, 95% range .* includes zero/);
  const better = evaluateChange({ travel: seeded(-0.15), treated: A, controls: controlsFor(A, [A, A2, ...C]), start: new Date(START).toISOString(), now: START + 6 * DAY });
  assert.equal(better.status, 'significant');
  assert.ok(Math.abs(better.effectPct + 0.15) < 0.02);
  assert.match(impactText(better), /faster: −15%/);
});

test('a change restricted to peak hours is measured only in those hours; thin data is refused', () => {
  const travel = seeded(0.1);
  const peak = evaluateChange({ travel, treated: A, controls: controlsFor(A, [A, A2, ...C]), start: new Date(START).toISOString(), hours: [16 * 60, 21 * 60], now: START + 6 * DAY, placebo: false });
  assert.equal(peak.status, 'significant');
  assert.ok(peak.slots <= 2 * 10, 'only evening half-hours, weekday and weekend');
  const early = evaluateChange({ travel, treated: A, controls: controlsFor(A, [A, A2, ...C]), start: new Date(START - 11 * DAY).toISOString(), now: START + 6 * DAY });
  assert.equal(early.status, 'insufficient');
  assert.match(impactText(early), /cannot be evaluated yet: only 3 days recorded before the change \(needs 5\)/);
  assert.equal(MIN.preDays, 5);
});

test('changes are stored with their roads, hours and source', () => {
  const store = createInterventionStore(new DatabaseSync(':memory:'));
  store.upsert({ id: 'omr-uturn-trial', title: 'U-turns closed', corridors: ['omr-south', 'omr-north'], start: '2026-09-24T02:30:00.000Z', end: '2026-09-24T06:30:00.000Z', source: 'https://example.org' });
  store.upsert({ id: 'omr-uturn-trial', title: 'U-turns closed near Geetham, BSR Mall and WTC', corridors: ['omr-south', 'omr-north'], start: '2026-09-24T02:30:00.000Z', end: '2026-09-24T06:30:00.000Z' });
  const [x] = store.list();
  assert.equal(x.title, 'U-turns closed near Geetham, BSR Mall and WTC');
  assert.deepEqual(x.corridors, ['omr-south', 'omr-north']);
});
