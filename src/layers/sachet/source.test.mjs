import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSachetSnapshot, createSachetSource } from './source.js';

const ring = [
  [80.0, 13.0],
  [80.1, 13.0],
  [80.1, 13.1],
  [80.0, 13.0],
];
const alert = (overrides = {}) => ({
  id: 'IN-1_1',
  sender: 'IMD-Chennai',
  sent: '2026-09-23T14:47:24.000Z',
  status: 'Actual',
  msgType: 'Alert',
  category: 'Met',
  event: 'Heavy Rain',
  urgency: 'Expected',
  severity: 'Severe',
  certainty: 'Likely',
  onset: '2026-09-23T14:47:24.000Z',
  expires: '2026-09-23T20:00:00.000Z',
  headline: 'Heavy rain over Chennai',
  description: '',
  instruction: 'Avoid waterlogged roads.',
  areaDesc: 'Chennai',
  localLanguage: 'ta',
  localHeadline: 'சென்னையில் கனமழை',
  centroid: { longitude: 80.05, latitude: 13.03 },
  polygons: [ring],
  capUrl: 'https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1',
  ...overrides,
});
const snapshot = (overrides = {}) => ({
  schemaVersion: 1,
  source: 'NDMA SACHET',
  attribution: 'NDMA SACHET',
  coverage: 'India',
  fetchedAt: 1,
  stale: false,
  unavailable: false,
  reason: null,
  indexed: 1,
  unmapped: 0,
  alerts: [alert()],
  ...overrides,
});

test('a well-formed snapshot round-trips with only the contract fields', () => {
  const result = validateSachetSnapshot({
    ...snapshot(),
    alerts: [{ ...alert(), extra: 'ignored', __proto__: { evil: true } }],
  });
  assert.equal(result.alerts.length, 1);
  assert.deepEqual(Object.keys(result.alerts[0]).sort(), Object.keys(alert()).sort());
  assert.equal(result.alerts[0].localHeadline, 'சென்னையில் கனமழை');
});

test('malformed alerts are rejected as a whole', () => {
  const bad = [
    { severity: 'Catastrophic' },
    { capUrl: 'https://evil.example/FetchXMLFile?identifier=1' },
    { capUrl: 'https://sachet.ndma.gov.in/other?identifier=1' },
    { headline: 'has <markup>' },
    { sent: '2026-09-23T14:47:24+05:30' },
    { centroid: null },
    { polygons: [], centroid: { longitude: 1, latitude: 1 } },
    { polygons: [[[80, 13], [81, 13], [81, 14]]] },
    { polygons: [[[80, 13], [81, 13], [81, 14], [80, 14]]] },
    { id: 'a b' },
  ];
  for (const overrides of bad)
    assert.throws(
      () => validateSachetSnapshot(snapshot({ alerts: [alert(overrides)] })),
      /Malformed/,
      JSON.stringify(overrides),
    );
  assert.throws(() =>
    validateSachetSnapshot(snapshot({ alerts: [alert(), alert()] })),
  );
  assert.throws(() =>
    validateSachetSnapshot(snapshot({ unavailable: true })),
  );
});

test('an unmapped alert is allowed when centroid and polygons are both absent', () => {
  const result = validateSachetSnapshot(
    snapshot({ alerts: [alert({ centroid: null, polygons: [] })], unmapped: 1 }),
  );
  assert.equal(result.alerts[0].centroid, null);
  assert.equal(result.unmapped, 1);
});

test('the source fetches same-origin, refuses redirects, and validates', async () => {
  let seen;
  const source = createSachetSource({
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(snapshot()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await source.getSnapshot({ signal: new AbortController().signal });
  assert.equal(seen.url, '/api/sachet');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(result.alerts[0].event, 'Heavy Rain');
  const failing = createSachetSource({
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(
    failing.getSnapshot({ signal: new AbortController().signal }),
    /HTTP 503/,
  );
});
