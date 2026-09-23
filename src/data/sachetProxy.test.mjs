import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  sachetProxy,
  parseSachetIndex,
  parseCapAlert,
  parseCapPolygon,
  decodeXmlText,
  SACHET_MAX_RING_POINTS,
} from '../../server/providers/sachet.js';

const RSS = `<?xml version="1.0"?><rss><channel>
<item><link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1790174844694008</link></item>
<item><link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1790174844694008</link></item>
<item><link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1790149945386017</link></item>
</channel></rss>`;

const CAP = (overrides = {}) => `<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
<cap:identifier>${overrides.identifier ?? 'IN-1790174844694008_8'}</cap:identifier>
<cap:sender>Andhra-Pradesh-SDMA</cap:sender>
<cap:sent>2026-09-23T20:17:24+05:30</cap:sent>
<cap:status>Actual</cap:status>
<cap:msgType>Alert</cap:msgType>
<cap:info>
<cap:language>en-IN</cap:language>
<cap:category>Met</cap:category>
<cap:event>Lightning</cap:event>
<cap:urgency>Expected</cap:urgency>
<cap:severity>${overrides.severity ?? 'Severe'}</cap:severity>
<cap:certainty>Possible</cap:certainty>
<cap:onset>2026-09-23T20:17:54+05:30</cap:onset>
<cap:expires>${overrides.expires ?? '2026-09-23T22:15:00+05:30'}</cap:expires>
<cap:headline>Lightning &amp; thunderstorm likely &lt;stay indoors&gt;</cap:headline>
<cap:instruction>Please follow SDMA guidelines.</cap:instruction>
<cap:parameter><cap:valueName>Polygon URL</cap:valueName><cap:value>https://sachet.ndma.gov.in/cap_public_website/FetchPolygonXMLFile?identifier=1790174844694008</cap:value></cap:parameter>
<cap:area><cap:areaDesc>14 Mandals</cap:areaDesc>${overrides.inlinePolygon ?? ''}</cap:area>
</cap:info>
<cap:info>
<cap:language>TL</cap:language>
<cap:category>Met</cap:category>
<cap:event>Lightning</cap:event>
<cap:headline>మీ ప్రాంతంలో పిడుగులు పడే అవకాశం ఉంది.</cap:headline>
</cap:info>
</cap:alert>`;

const POLYGON = `<alert><identifier>IN-1790174844694008_8</identifier>
<polygon>16.35,80.35 16.30,80.35 16.30,80.40 16.35,80.40 16.35,80.35</polygon>
<polygon>15.0,79.0 15.1,79.0 15.1,79.1</polygon>
</alert>`;

test('index parsing keeps feed order and drops duplicate identifiers', () => {
  assert.deepEqual(parseSachetIndex(RSS), [
    '1790174844694008',
    '1790149945386017',
  ]);
});

test('XML entities decode and markup never survives into text fields', () => {
  assert.equal(decodeXmlText('a &amp; b &#x41;&#66; &lt;'), 'a & b AB <');
  const alert = parseCapAlert('1790174844694008', CAP(), POLYGON);
  assert.equal(alert.headline, 'Lightning & thunderstorm likely');
});

test('a CAP message normalizes with UTC times, English info and a local headline', () => {
  const alert = parseCapAlert('1790174844694008', CAP(), POLYGON);
  assert.equal(alert.id, 'IN-1790174844694008_8');
  assert.equal(alert.sender, 'Andhra-Pradesh-SDMA');
  assert.equal(alert.sent, '2026-09-23T14:47:24.000Z');
  assert.equal(alert.expires, '2026-09-23T16:45:00.000Z');
  assert.equal(alert.severity, 'Severe');
  assert.equal(alert.category, 'Met');
  assert.equal(alert.event, 'Lightning');
  assert.equal(alert.areaDesc, '14 Mandals');
  assert.equal(alert.localLanguage, 'TL');
  assert.match(alert.localHeadline, /పిడుగులు/);
  assert.equal(alert.polygons.length, 2);
  assert.deepEqual(alert.polygons[0][0], [80.35, 16.35]);
  assert.deepEqual(alert.polygons[0].at(-1), alert.polygons[0][0]);
  assert.deepEqual(alert.polygons[1].at(-1), alert.polygons[1][0]);
  assert.ok(Math.abs(alert.centroid.latitude - 15.786) < 0.01);
  assert.equal(
    alert.capUrl,
    'https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1790174844694008',
  );
});

test('unknown enumerations fall back instead of leaking upstream text', () => {
  const alert = parseCapAlert(
    '1',
    CAP({ severity: 'Catastrophic<script>' }),
    POLYGON,
  );
  assert.equal(alert.severity, 'Unknown');
});

test('inline polygons win over the separate polygon document', () => {
  const alert = parseCapAlert(
    '1',
    CAP({ inlinePolygon: '<cap:polygon>13.0,80.0 13.1,80.0 13.1,80.1 13.0,80.0</cap:polygon>' }),
    POLYGON,
  );
  assert.equal(alert.polygons.length, 1);
  assert.deepEqual(alert.polygons[0][0], [80.0, 13.0]);
});

test('polygon parsing rejects garbage and decimates dense rings', () => {
  assert.equal(parseCapPolygon('1,2 3,4'), null);
  assert.equal(parseCapPolygon('91,0 0,0 0,1'), null);
  assert.equal(parseCapPolygon('a,b c,d e,f'), null);
  const dense = Array.from({ length: 5000 }, (_, i) => `${10 + i / 10000},${80 + i / 10000}`).join(' ');
  const ring = parseCapPolygon(dense);
  assert.equal(ring.length, SACHET_MAX_RING_POINTS + 1);
  assert.deepEqual(ring.at(-1), ring[0]);
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-length': String(Buffer.byteLength(body)) }),
    body: null,
    text: async () => body,
  };
}
function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    for (const [pattern, reply] of routes)
      if (url.includes(pattern)) return typeof reply === 'function' ? reply() : reply;
    throw new Error(`unexpected ${url}`);
  };
}
async function invoke(plugin, url = '/', method = 'GET') {
  const middlewares = { use: (_path, handler) => (plugin.handler = handler) };
  plugin.configureServer({ middlewares });
  const res = new EventEmitter();
  let status, body;
  res.writeHead = (code) => (status = code);
  res.end = (value) => (body = JSON.parse(value));
  await plugin.handler({ method, url }, res);
  return { status, body };
}

test('proxy serves a sorted snapshot, memoizes messages, and drops expired alerts', async () => {
  const calls = [];
  let now = Date.parse('2026-09-23T15:00:00Z');
  const rss = `<rss>
<link>x/FetchXMLFile?identifier=1</link>
<link>x/FetchXMLFile?identifier=2</link>
<link>x/FetchXMLFile?identifier=3</link></rss>`;
  const plugin = sachetProxy({
    now: () => now,
    fetchImpl: fakeFetch(
      [
        ['rss_india.xml', () => response(rss)],
        ['FetchXMLFile?identifier=1', () => response(CAP({ identifier: 'A', severity: 'Moderate' }))],
        ['FetchXMLFile?identifier=2', () => response(CAP({ identifier: 'B', severity: 'Extreme' }))],
        ['FetchXMLFile?identifier=3', () => response(CAP({ identifier: 'C', expires: '2026-09-20T00:00:00Z' }))],
        ['FetchPolygonXMLFile?identifier=1', () => response(POLYGON)],
        ['FetchPolygonXMLFile?identifier=2', () => response('', 403)],
        ['FetchPolygonXMLFile?identifier=3', () => response(POLYGON)],
      ],
      calls,
    ),
  });
  const first = await invoke(plugin);
  assert.equal(first.status, 200);
  assert.equal(first.body.schemaVersion, 1);
  assert.equal(first.body.stale, false);
  assert.equal(first.body.indexed, 3);
  assert.deepEqual(
    first.body.alerts.map((alert) => alert.id),
    ['B', 'A'],
    'most severe first; the expired alert is gone',
  );
  assert.equal(first.body.alerts[0].polygons.length, 0, 'a refused polygon leaves the alert unmapped');
  assert.equal(first.body.alerts[0].centroid, null);
  assert.equal(first.body.unmapped, 1);
  const fetched = calls.length;
  now += 60_000;
  await invoke(plugin);
  assert.equal(calls.length, fetched, 'inside the refresh window nothing is fetched');
  now += 11 * 60_000;
  const third = await invoke(plugin);
  assert.equal(third.status, 200);
  assert.equal(
    calls.length,
    fetched + 2,
    'a refresh re-reads the index and retries only the refused polygon; memoized messages are not fetched again',
  );
  assert.equal(calls.at(-1).includes('FetchPolygonXMLFile?identifier=2'), true);
});

test('proxy serves the cached snapshot as stale while upstream fails, and rejects other requests', async () => {
  let now = Date.parse('2026-09-23T15:00:00Z');
  let fail = false;
  const plugin = sachetProxy({
    now: () => now,
    fetchImpl: fakeFetch([
      ['rss_india.xml', () => (fail ? response('', 503) : response('<a>FetchXMLFile?identifier=1</a>'))],
      ['FetchXMLFile?identifier=1', () => response(CAP({ identifier: 'A' }))],
      ['FetchPolygonXMLFile?identifier=1', () => response(POLYGON)],
    ]),
  });
  assert.equal((await invoke(plugin)).body.alerts.length, 1);
  fail = true;
  now += 11 * 60_000;
  const stale = await invoke(plugin);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.alerts.length, 1);
  assert.equal((await invoke(plugin, '/?x=1')).status, 400);
  assert.equal((await invoke(plugin, '/', 'POST')).status, 405);
});

test('a refresh whose messages mostly fail is an outage, not an empty India', async () => {
  let now = Date.parse('2026-09-23T15:00:00Z');
  let broken = false;
  const plugin = sachetProxy({
    now: () => now,
    fetchImpl: fakeFetch([
      ['rss_india.xml', () => response(broken ? '<a>FetchXMLFile?identifier=3</a><a>FetchXMLFile?identifier=4</a>' : '<a>FetchXMLFile?identifier=1</a><a>FetchXMLFile?identifier=2</a>')],
      ['FetchXMLFile?identifier=', () => (broken ? response('', 500) : response(CAP({ identifier: 'A' }), 200))],
      ['FetchPolygonXMLFile', () => response(POLYGON)],
    ]),
  });
  const first = await invoke(plugin);
  assert.equal(first.body.alerts.length, 1, 'duplicate identifiers collapse to one alert');
  broken = true;
  now += 11 * 60_000;
  const next = await invoke(plugin);
  assert.equal(next.body.stale, true);
  assert.equal(next.body.alerts.length, 1);
});

test('a refused polygon is retried on a later refresh without re-fetching the CAP message', async () => {
  let now = Date.parse('2026-09-23T15:00:00Z');
  let refuse = true;
  const calls = [];
  const plugin = sachetProxy({
    now: () => now,
    fetchImpl: fakeFetch(
      [
        ['rss_india.xml', () => response('<a>FetchXMLFile?identifier=1</a>')],
        ['FetchXMLFile?identifier=1', () => response(CAP({ identifier: 'A' }))],
        ['FetchPolygonXMLFile', () => (refuse ? response('', 403) : response(POLYGON))],
      ],
      calls,
    ),
  });
  const first = await invoke(plugin);
  assert.equal(first.body.alerts[0].polygons.length, 0);
  assert.equal(first.body.unmapped, 1);
  assert.equal('capXml' in first.body.alerts[0], false, 'internal fields never leave the proxy');
  refuse = false;
  now += 11 * 60_000;
  const second = await invoke(plugin);
  assert.equal(second.body.alerts[0].polygons.length, 2);
  assert.equal(second.body.unmapped, 0);
  assert.equal(calls.filter((url) => url.includes('FetchXMLFile?identifier=1')).length, 1);
});

test('a burst of polygon refusals stops the refresh from asking again until the next one', async () => {
  const calls = [];
  const rss = Array.from({ length: 6 }, (_, i) => `<a>FetchXMLFile?identifier=${i + 1}</a>`).join('');
  const plugin = sachetProxy({
    now: () => Date.parse('2026-09-23T15:00:00Z'),
    fetchImpl: fakeFetch(
      [
        ['rss_india.xml', () => response(rss)],
        ['FetchXMLFile?identifier=', () => response(CAP({ identifier: `id-${calls.length}` }))],
        ['FetchPolygonXMLFile', () => response('', 403)],
      ],
      calls,
    ),
  });
  const result = await invoke(plugin);
  assert.equal(result.body.alerts.length, 6);
  assert.equal(result.body.unmapped, 6);
  const asked = calls.filter((url) => url.includes('FetchPolygonXMLFile')).length;
  // Two workers may each be mid-request when the limit is reached.
  assert.ok(asked >= 3 && asked <= 4, `asked ${asked} times`);
});
