import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeIncident, fetchIncidents, createIncidentStore, hotspots } from '../src/incidents.mjs';
import { renderSummary, touchesTamilNadu, inTamilNadu } from '../src/summary.mjs';

const raw = (id, icon, lon, lat, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + 0.001, lat], [lon + 0.002, lat]] },
  properties: { id, iconCategory: icon, magnitudeOfDelay: 3, delay: 300, from: 'Sholinganallur', to: 'Karapakkam', roadNumbers: ['SH49A'], events: [{ description: 'Stationary traffic' }], ...extra },
});

test('incidents normalize with a midpoint and a category name', () => {
  const i = normalizeIncident(raw('x1', 1, 80.228, 12.9));
  assert.equal(i.category, 'accident');
  assert.equal(i.lon, 80.229);
  assert.equal(i.road, 'SH49A');
  assert.equal(normalizeIncident({ properties: { id: 'no-geometry' } }), null);
});

test('fetch asks TomTom for the city box with present incidents only', async () => {
  let asked = '';
  const list = await fetchIncidents({ key: 'k', fetchImpl: async (url) => ((asked = url), { ok: true, json: async () => ({ incidents: [raw('a', 6, 80.2, 13.0)] }) }) });
  assert.equal(list.length, 1);
  assert.match(asked, /bbox=80%2C12\.75%2C80\.35%2C13\.25/);
  assert.match(asked, /timeValidityFilter=present/);
});

test('the store keeps first sighting, counts polls, and hotspots weigh accidents and recurring jams', () => {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'inc-')), 'i.db'));
  const store = createIncidentStore(db);
  const sholi = (id, icon, extra) => normalizeIncident(raw(id, icon, 80.2279, 12.901, extra));
  store.record([sholi('acc-1', 1), sholi('jam-1', 6)], '2026-09-26T13:00:00.000Z');
  store.record([sholi('acc-1', 1), sholi('jam-1', 6)], '2026-09-26T13:15:00.000Z');
  store.record([sholi('jam-2', 6), sholi('closed', 8)], '2026-09-27T13:00:00.000Z');
  store.record([sholi('minor', 6, { magnitudeOfDelay: 1 }), normalizeIncident(raw('far', 1, 80.1, 13.1))], '2026-09-28T13:00:00.000Z');
  const acc = db.prepare('SELECT * FROM incidents WHERE id = ?').get('acc-1');
  assert.equal(acc.polls, 2);
  assert.equal(acc.first_seen, '2026-09-26T13:00:00.000Z');
  assert.equal(store.current().length, 2);
  const spots = hotspots(store.since('2026-09-01T00:00:00Z'), { minScore: 3 });
  assert.equal(spots.length, 2);
  const top = spots[0];
  assert.equal(top.place, 'Sholinganallur → Karapakkam');
  assert.equal(top.score, 7, 'accident 5 + one major jam per day on two days; closures and minor jams ignored');
  assert.deepEqual(top.kinds, { accident: 1, jam: 2 });
  assert.equal(top.days, 2);
  assert.equal(spots[1].kinds.accident, 1);
});

test('the Tamil Nadu outline keeps TN cities and drops neighbours', () => {
  const inside = { Chennai: [80.27, 13.08], Hosur: [77.83, 12.74], Coimbatore: [76.96, 11.0], Madurai: [78.12, 9.93], Kanyakumari: [77.54, 8.09], Nagapattinam: [79.84, 10.77], Tirunelveli: [77.7, 8.73], Vellore: [79.13, 12.92], Ooty: [76.7, 11.41] };
  const outside = { Bengaluru: [77.59, 12.97], Tirupati: [79.42, 13.63], Kochi: [76.27, 9.93], Thiruvananthapuram: [76.95, 8.52], Mysuru: [76.64, 12.3], Nellore: [79.99, 14.44] };
  for (const [name, [lon, lat]] of Object.entries(inside)) assert.equal(inTamilNadu(lon, lat), true, name);
  for (const [name, [lon, lat]] of Object.entries(outside)) assert.equal(inTamilNadu(lon, lat), false, name);
});

test('Tamil Nadu filter and the public page render from stored data', () => {
  const sachetTN = { source: 'sachet', severity: 'warning', event: 'Heavy rain', headline: 'Heavy rain in Chennai', sender: 'IMD Chennai', geometry: { type: 'polygon', rings: [[[80.1, 13.0], [80.3, 13.0], [80.3, 13.2], [80.1, 13.0]]] } };
  const sachetDelhi = { ...sachetTN, headline: 'Delhi', geometry: { type: 'polygon', rings: [[[77.1, 28.6], [77.3, 28.6], [77.2, 28.7], [77.1, 28.6]]] } };
  const storm = { source: 'jtwc', severity: 'warning', headline: 'Cyclone near Chennai', sender: 'JTWC', geometry: { type: 'line', points: [[84, 12], [81.5, 13]] } };
  assert.equal(touchesTamilNadu(sachetTN), true);
  assert.equal(touchesTamilNadu(sachetDelhi), false);
  assert.equal(touchesTamilNadu(storm), true);
  const corridor = { id: 'omr-south', name: 'OMR southbound · Madhya Kailash → Siruseri', lengthKm: 22.1, definition: { road: 'omr', sections: [] } };
  const html = renderSummary({
    roads: [{ corridor, status: { ts: '2026-09-29T12:30:00Z', minutes: 61, freeMinutes: 38, usualMinutes: 52, usualSource: 'recorded', vsUsual: 9, level: 'heavy', slowest: { section: 'Perungudi → Thoraipakkam', extraMinutes: 8 }, jams: 2 }, tips: [{ kind: 'depart', text: 'In the evening, leaving at 16:30 instead of 18:30 saves about 14 min.' }] }],
    events: [sachetTN, sachetDelhi, storm,
      { source: 'heat', severity: 'critical', headline: 'Madurai: feels like 42°', value: { peakC: 43 }, geometry: { type: 'point', lat: 9.93, lon: 78.12 } },
      { source: 'heat', severity: 'critical', headline: 'Bengaluru: feels like 42°', value: { peakC: 42 }, geometry: { type: 'point', lat: 12.97, lon: 77.59 } },
      { source: 'heat', severity: 'warning', headline: 'Salem: feels like 38°', value: { peakC: 38 }, geometry: { type: 'point', lat: 11.66, lon: 78.15 } }],
    incidentsNow: [{ category: 'accident', from_name: 'Tidel Park', to_name: 'Perungudi', lat: 12.98, lon: 80.248, delay_s: 600 }],
    hotspots: [{ place: 'Sholinganallur → Karapakkam', reports: 3, days: 2, kinds: { accident: 1, jam: 2 }, lat: 12.9, lon: 80.23 }],
  });
  assert.match(html, /61<small> min now/);
  assert.match(html, /\+9 vs usual/);
  assert.match(html, /Slowest now: Perungudi → Thoraipakkam \(\+8 min\)/);
  assert.match(html, /leaving at 16:30 instead of 18:30/);
  assert.match(html, /Heavy rain in Chennai/);
  assert.doesNotMatch(html, />Delhi</);
  assert.match(html, /Cyclone near Chennai/);
  assert.match(html, /Tidel Park → Perungudi/);
  assert.match(html, /Sholinganallur → Karapakkam/);
  assert.match(html, /not official accident records/);
  assert.match(html, /Feels like 41° or more today in Madurai 43°/);
  assert.doesNotMatch(html, /Bengaluru|Salem/);
});
