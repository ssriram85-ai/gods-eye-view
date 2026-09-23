import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { deflateRawSync } from 'node:zlib';
import {
  jtwcProxy,
  parseJtwcIndex,
  parseJmv,
  parseKml,
  extractKml,
  buildStorm,
} from '../../server/providers/jtwc.js';

const RSS = `<rss><channel><item>
<title>Current Northwest Pacific/North Indian Ocean* Tropical Systems</title>
<description><![CDATA[<p><b>Tropical Depression  25W (Surigae) Warning #02 </b><br>
<b>Issued at 23/1500Z<b>
<ul><li><a href='https://www.metoc.navy.mil/jtwc/products/wp2526web.txt'>TC Warning Text </a></li>
<li><a href='https://www.metoc.navy.mil/jtwc/products/wp2526.tcw'>JMV 3.0 Data</a></li></ul>
<p><b>Tropical Cyclone  01B (One) Warning #04 </b><br>
<b>Issued at 23/1500Z<b>
<ul><li><a href='https://www.metoc.navy.mil/jtwc/products/io0126web.txt'>TC Warning Text </a></li>
<li><a href='https://www.metoc.navy.mil/jtwc/products/io0126.tcw'>JMV 3.0 Data</a></li>
<li><a href='https://www.metoc.navy.mil/jtwc/products/io0126.kmz'>Google Earth Overlay</a></li></ul>
]]></description></item>
<item><title>Current Central/Eastern Pacific Tropical Systems</title>
<description><![CDATA[<p><b>Hurricane  17E (Polo) Warning #12 </b><br>
<ul><li><a href='https://www.metoc.navy.mil/jtwc/products/ep1726.tcw'>JMV 3.0 Data</a></li></ul>]]></description></item>
</channel></rss>`;

const JMV = `WTIO51 PGTW 231500
WARNING    ATCG MIL 01B NIO 260923125702
2026092312 01B ONE        004  01 270 06 SATL RADR 030
T000 178N 0840E 045 R034 025 NE QD 040 SE QD 045 SW QD 035 NW QD
T012 183N 0835E 040 R034 020 NE QD 030 SE QD 030 SW QD 030 NW QD
T024 188N 0832E 030
AMP
   MAX SUSTAINED WINDS - 045 KT, GUSTS 055 KT
   MAX SUSTAINED WINDS - 040 KT, GUSTS 050 KT
   MAX SUSTAINED WINDS - 030 KT, GUSTS 040 KT
REMARKS:
MB. MINIMUM CENTRAL PRESSURE AT 231200Z IS 990
MB. MINIMUM CENTRAL PRESSURE AT 231200Z IS 990 MB. NEXT
NNNN`;

const KML = `<?xml version="1.0"?><kml><Document>
<Placemark><name>io01 Storm Track</name><LineString><coordinates>
084.0,17.8,0 083.5,18.3,0 083.2,18.8,0 </coordinates></LineString></Placemark>
<Placemark><name>34 knot Danger Swath</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
83.37,20.12,0 84.5,20.0,0 84.6,17.0,0 83.0,17.5,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>26092306Z</name><Point><coordinates>84.6,17.8,0</coordinates></Point></Placemark>
</Document></kml>`;

/** A minimal zip with one deflated doc.kml entry, as a KMZ is. */
function kmz(kml = KML, method = 8) {
  const name = Buffer.from('doc.kml');
  const raw = Buffer.from(kml);
  const data = method === 8 ? deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  const cdOffset = local.length + name.length + data.length;
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(
    Buffer.concat([local, name, data, central, name, eocd]),
  );
}

test('the RSS index keeps io/wp/sh warnings in order and ignores NHC-mirrored basins', () => {
  assert.deepEqual(parseJtwcIndex(RSS), [
    {
      code: 'wp2526',
      basin: 'wp',
      id: 'wp252026',
      designation: '25W',
      name: 'Surigae',
      classification: 'TD',
      warningNumber: '2',
    },
    {
      code: 'io0126',
      basin: 'io',
      id: 'io012026',
      designation: '01B',
      name: 'One',
      classification: 'TC',
      warningNumber: '4',
    },
  ]);
});

test('JMV 3.0 parses positions, winds, gusts, movement, pressure and warning times', () => {
  const jmv = parseJmv(JMV);
  assert.equal(jmv.warningNumber, '4');
  assert.equal(jmv.positionAt, '2026-09-23T12:00:00.000Z');
  assert.equal(jmv.issuedAt, '2026-09-23T15:00:00.000Z');
  assert.deepEqual(jmv.movement, { directionDegrees: 270, speedKt: 6 });
  assert.equal(jmv.windKt, 45);
  assert.equal(jmv.pressureHpa, 990);
  assert.deepEqual(
    jmv.forecastPoints.map((p) => [
      p.tauHours,
      p.position.latitude,
      p.position.longitude,
      p.windKt,
      p.gustKt,
    ]),
    [
      [0, 17.8, 84, 45, 55],
      [12, 18.3, 83.5, 40, 50],
      [24, 18.8, 83.2, 30, 40],
    ],
  );
  assert.deepEqual(jmv.forecastPoints[0].radiiNm, { r34: [25, 40, 45, 35] });
  assert.throws(() => parseJmv('garbage'), /invalid_jtwc_data/);
  assert.throws(
    () => parseJmv(JMV.replace('T012', 'T000')),
    /invalid_jtwc_data/,
    'non-increasing lead hours are rejected',
  );
});

test('southern hemisphere and western longitudes sign correctly; month rollover keeps issue after position', () => {
  const sh = parseJmv(
    'WTXS31 PGTW 010300\nX\n2026093018 05S FIVE 001 01 100 10 SATL 030\nT000 152S 0553E 045\n',
  );
  assert.equal(sh.forecastPoints[0].position.latitude, -15.2);
  assert.equal(sh.forecastPoints[0].position.longitude, 55.3);
  assert.equal(sh.positionAt, '2026-09-30T18:00:00.000Z');
  assert.equal(sh.issuedAt, '2026-10-01T03:00:00.000Z');
  const w = parseJmv(
    'WTPN31 PGTW 231500\nX\n2026092312 17E POLO 012 03 335 04 SATL 015\nT000 152N 1015W 130\n',
  );
  assert.equal(w.forecastPoints[0].position.longitude, -101.5);
});

test('the KMZ unzips with Node alone and yields the forecast track and danger swath', () => {
  const kml = extractKml(kmz());
  assert.match(kml, /Danger Swath/);
  const geometry = parseKml(kml);
  assert.deepEqual(geometry.track, {
    type: 'LineString',
    coordinates: [
      [84, 17.8],
      [83.5, 18.3],
      [83.2, 18.8],
    ],
  });
  assert.equal(geometry.cone.type, 'Polygon');
  assert.equal(geometry.cone.coordinates[0].length, 5, 'ring is closed');
  assert.deepEqual(geometry.cone.coordinates[0].at(-1), [83.37, 20.12]);
  assert.match(extractKml(kmz(KML, 0)), /Storm Track/, 'stored entries work too');
  assert.throws(() => extractKml(new Uint8Array([1, 2, 3])), /invalid_jtwc_data/);
  assert.deepEqual(parseKml('<kml></kml>'), { track: null, cone: null });
});

test('storms assemble in the NHC-compatible schema, and lose geometry when the overlay is missing', () => {
  const [, entry] = parseJtwcIndex(RSS);
  const jmv = parseJmv(JMV);
  const storm = buildStorm(entry, jmv, parseKml(KML));
  assert.equal(storm.id, 'io012026');
  assert.equal(storm.basin, 'IO');
  assert.equal(storm.name, 'One');
  assert.equal(storm.classification, 'TC');
  assert.equal(storm.advisoryNumber, '4');
  assert.equal(storm.geometryStatus, 'current');
  assert.equal(storm.geometryAdvisoryNumber, '4');
  assert.equal(storm.forecastPoints.length, 3);
  assert.equal('radiiNm' in storm.forecastPoints[0], false);
  assert.equal(
    storm.advisoryUrl,
    'https://www.metoc.navy.mil/jtwc/products/io0126web.txt',
  );
  assert.equal(
    storm.outlookUrl,
    'https://www.metoc.navy.mil/jtwc/products/abioweb.txt',
  );
  const bare = buildStorm(entry, jmv, null);
  assert.equal(bare.geometryStatus, 'unavailable');
  assert.deepEqual(bare.forecastPoints, []);
  assert.equal(bare.track, null);
  assert.equal(bare.cone, null);
  assert.deepEqual(bare.position, { longitude: 84, latitude: 17.8 });
});

function response(body, status = 200) {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-length': String(bytes.byteLength) }),
    body: null,
    text: async () => String(body),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    for (const [pattern, reply] of routes)
      if (url.includes(pattern)) return reply();
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

test('proxy serves storms with geometry, tolerates a missing overlay, caches, and goes stale on outage', async () => {
  let now = Date.parse('2026-09-23T16:00:00Z');
  let down = false;
  const calls = [];
  const plugin = jtwcProxy({
    now: () => now,
    fetchImpl: fakeFetch(
      [
        ['jtwc.rss', () => (down ? response('', 503) : response(RSS))],
        ['io0126.tcw', () => response(JMV)],
        ['io0126.kmz', () => response(kmz())],
        ['wp2526.tcw', () => response(JMV.replace('01B ONE', '25W SURIGAE'))],
        ['wp2526.kmz', () => response('', 404)],
      ],
      calls,
    ),
  });
  const first = await invoke(plugin);
  assert.equal(first.status, 200);
  assert.equal(first.body.stale, false);
  assert.equal(first.body.source, 'JTWC');
  assert.deepEqual(
    first.body.storms.map((s) => [s.id, s.geometryStatus]),
    [
      ['wp252026', 'unavailable'],
      ['io012026', 'current'],
    ],
  );
  assert.equal(first.body.storms[1].cone.coordinates[0].length, 5);
  const fetched = calls.length;
  now += 60_000;
  await invoke(plugin);
  assert.equal(calls.length, fetched, 'served from cache inside the window');
  down = true;
  now += 11 * 60_000;
  const stale = await invoke(plugin);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.storms.length, 2);
  assert.equal((await invoke(plugin, '/?x=1')).status, 400);
  assert.equal((await invoke(plugin, '/', 'POST')).status, 405);
});
