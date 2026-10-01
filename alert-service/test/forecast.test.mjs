import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { forecastRoad, anomalyNow, createForecastStore, skillText, HORIZONS } from '../src/forecast.mjs';
import { rainEffect, rainText, MIN } from '../src/raineffect.mjs';
import { briefSection, renderBriefs } from '../src/brief.mjs';
import { renderImpactPage } from '../src/impactpage.mjs';

const slotRow = (h, m, minutes) => ({ slot: h * 60 + m, label: '', days: 3, minutes, p10: minutes - 3, p90: minutes + 4 });
const weekday = []; for (let t = 0; t < 1440; t += 30) weekday.push(slotRow(Math.floor(t / 60), t % 60, 40));
const profile = { weekday, weekend: [] };
const NOW = Date.parse('2026-10-01T12:30:00Z'); // Thursday 18:00 IST

test('a road running 20% over typical gets forecasts that start high and fade towards typical', () => {
  const recent = [0, 15, 30].map((m) => ({ ts: new Date(NOW - (30 - m) * 60_000).toISOString(), minutes: 48 }));
  assert.ok(Math.abs(anomalyNow(recent, profile) - 0.2) < 1e-9);
  const f = forecastRoad({ profile, recent, nowMs: NOW });
  assert.deepEqual(f.map((x) => x.horizon), [...HORIZONS]);
  const at = (h) => f.find((x) => x.horizon === h).minutes;
  assert.ok(Math.abs(at(15) - 40 * (1 + 0.2 * Math.exp(-15 / 60))) < 1e-9);
  assert.ok(at(15) > at(60) && at(60) > at(120) && at(120) > 40, 'fades towards typical');
  assert.equal(f[0].persistence, 48);
  assert.equal(f[0].typical, 40);
  assert.ok(f[0].low < f[0].minutes && f[0].high > f[0].minutes);
  assert.deepEqual(forecastRoad({ profile, recent: [], nowMs: NOW }), []);
});

test('forecasts are stored, scored against the real drive, and compared with two rivals', () => {
  const store = createForecastStore(new DatabaseSync(':memory:'));
  const issued = new Date(NOW - 3 * 3600_000).toISOString();
  store.issue('omr-south', issued, [
    { horizon: 60, target: new Date(NOW - 2 * 3600_000).toISOString(), minutes: 50, low: 46, high: 55, typical: 44, persistence: 40 },
    { horizon: 120, target: new Date(NOW - 3600_000).toISOString(), minutes: 45, low: 41, high: 49, typical: 44, persistence: 40 },
  ]);
  const totals = [{ ts: new Date(NOW - 2 * 3600_000 + 4 * 60_000).toISOString(), minutes: 52 }, { ts: new Date(NOW - 3600_000 + 20 * 60_000).toISOString(), minutes: 60 }];
  assert.equal(store.score('omr-south', totals), 1, 'only the target with a reading within 8 minutes is scored');
  const [s60, s120] = store.skill('omr-south', '2000-01-01T00:00:00Z').filter((x) => [60, 120].includes(x.horizon));
  assert.equal(s60.n, 1);
  assert.ok(Math.abs(s60.forecastError - 2 / 52) < 1e-9 && Math.abs(s60.noChangeError - 12 / 52) < 1e-9 && Math.abs(s60.normalDayError - 8 / 52) < 1e-9);
  assert.equal(s60.coverage, 1);
  assert.equal(s120.n, 0);
  assert.equal(skillText(store.skill('omr-south', '2000-01-01T00:00:00Z'), 60), '60 min ahead, over 1 forecasts: typical error 4% (assuming no change: 23%; assuming a normal day: 15%), better than both; the real drive fell inside the forecast range 100% of the time');
  assert.equal(skillText([], 60), 'no forecast has reached its target time yet');
  assert.equal(store.latest('omr-south').list.length, 2);
});

test('rain effect needs enough wet readings, then reports minutes per band and the worst stretch', () => {
  const corridor = { id: 'omr-south', definition: { sections: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }] } };
  const rows = [], rain = new Map();
  const base = Date.parse('2026-10-05T00:00:00Z'); // rain comes on whole UTC hours, as Open-Meteo reports it
  for (let d = 0; d < 6; d++)
    for (let h = 0; h < 24; h++) {
      const hour = base + d * 86_400_000 + h * 3_600_000;
      const wet = d >= 3 && h >= 8 && h < 11; // three wet afternoons (13:30–16:30 IST), 8 mm an hour
      rain.set(new Date(hour).toISOString(), wet ? 8 : 0);
      for (const q of [0, 30]) {
        const ts = new Date(hour + q * 60_000).toISOString();
        rows.push({ ts, leg: 0, travel_s: (10 + (wet ? 2 : 0)) * 60 }, { ts, leg: 1, travel_s: (12 + (wet ? 6 : 0)) * 60 });
      }
    }
  const thin = rainEffect({ corridor, rows: rows.filter((r) => r.ts < new Date(base + 4 * 86_400_000).toISOString()), rain });
  assert.match(rainText(thin), /^not enough rain recorded yet \(6 wet readings; each band needs 6 across 2 days\)$/);
  const e = rainEffect({ corridor, rows, rain });
  const moderate = e.bands.find((b) => b.band === 'moderate');
  assert.equal(moderate.enough, true);
  // Day 5 is a Saturday: its wet readings have no dry Saturday to compare with, so they are left out.
  assert.equal(moderate.readings, 12);
  assert.equal(moderate.days, 2);
  assert.equal(moderate.extraMinutes, 8);
  assert.deepEqual(moderate.stretches.map((s) => s.extraMinutes), [2, 6]);
  assert.equal(rainText(e), 'moderate rain adds about 8 min; the stretch that suffers most is B → C (+6 min in moderate rain)');
  assert.equal(MIN.readings, 6);
  const small = { bands: [{ band: 'drizzle', enough: true, extraMinutes: -2, stretches: [{ stretch: 'X → Y', extraMinutes: 0.2 }] }, { band: 'light', enough: true, extraMinutes: 0.8, stretches: [{ stretch: 'X → Y', extraMinutes: 0.4 }] }] };
  assert.equal(rainText(small), 'drizzle rain: drives were 2 min quicker than usual, which needs more wet days to explain; light rain: no clear effect', 'no worst stretch named at a trivial effect');
});

test('the brief prints one page per road and says plainly when it is not for formal use', () => {
  const insight = {
    corridor: { id: 'omr-south', name: 'OMR southbound · Madhya Kailash → Siruseri', lengthKm: 22.6, definition: { sections: [{}, {}] } },
    status: { ts: '2026-10-01T12:30:00Z', minutes: 61, usualMinutes: 58, usualRange: [55, 63], nightMinutes: 36, level: 'heavy', unusual: false },
    baseline: { minutes: 36 }, confidence: { level: 'early', text: 'early data' }, formal: { ready: false, text: 'Not yet: needs many more weekdays recorded; needs 40 more Google checks.' },
    source: { text: 'varies day to day (live): in 25% of half-hour slots…' }, tips: [{ kind: 'rush', text: 'Evening peak at 18:30 (about 63 min).' }], notes: [],
    agreement: null, truth: null,
  };
  const forecast = { list: [{ horizon: 60, target_ts: '2026-10-01T13:30:00Z', minutes: 57, low: 53, high: 61 }, { horizon: 120, target_ts: '2026-10-01T14:30:00Z', minutes: 48, low: 44, high: 52 }] };
  const page = briefSection({ insight, totals: [], forecast, skill: [], rain: { bands: [], wetReadings: 0 }, impacts: [], generatedAt: '2026-10-01T12:31:00Z' });
  assert.match(page, /Not yet for formal use<span>needs many more weekdays recorded; needs 40 more Google checks\.<\/span>/);
  assert.match(page, /<b>48 min<\/b><em>44–52 expected<\/em>/, 'two-hour tile');
  assert.match(page, /<th>19:00<\/th><th>20:00<\/th>/);
  assert.match(page, /Observations, not findings: not for formal submissions/);
  const doc = renderBriefs({ sections: [page, page] });
  assert.match(doc, /@page\{size:A4/);
  assert.match(doc, /page-break-after:always/);
  assert.equal((doc.match(/<section class="page">/g) || []).length, 2);
  const imp = renderImpactPage({ evaluations: [{ title: 'U-turns closed', start: '2026-09-24T02:30:00Z', end: '2026-09-24T06:30:00Z', results: [{ corridor: 'omr-south', result: { status: 'insufficient', problems: ['only 0 days recorded before the change (needs 5)'] } }] }], corridors: [insight.corridor], names: { 'omr-south': 'OMR southbound' } });
  assert.match(imp, /OMR southbound: cannot be evaluated yet: only 0 days recorded before the change \(needs 5\)\./);
  assert.match(imp, /Evaluate a change yourself/);
});
