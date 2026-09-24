import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createService } from './service.mjs';
import { createCorridorStore, resolveCorridor, sampleCorridor, profile, compareProfiles, SEED_CORRIDORS } from './corridor.mjs';
import { renderReport } from './report.mjs';

const PORT = Number(process.env.PORT || 4180);
// Loopback by default (a laptop); a hosted deployment sets HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = (process.env.GEV_BASE_URL || 'http://localhost:4173').replace(/\/$/, '');
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 10);
const DATA_DIR = process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TOMTOM_KEY = (process.env.TOMTOM_API_KEY || '').trim();
const CORRIDOR_MINUTES = Number(process.env.CORRIDOR_MINUTES || 15);

const service = createService({ baseUrl: BASE_URL, dataDir: DATA_DIR });
const corridors = createCorridorStore(join(DATA_DIR, 'corridors.db'));

const parseWindow = (text) => {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  // Local (IST) calendar days → UTC instants.
  const from = new Date(`${m[1]}T00:00:00+05:30`).toISOString();
  const to = new Date(new Date(`${m[2]}T00:00:00+05:30`).getTime() + 86_400_000).toISOString();
  return { from, to, label: `${m[1]} → ${m[2]}` };
};

async function sampleAllCorridors() {
  if (!TOMTOM_KEY) return { skipped: 'TOMTOM_API_KEY not set' };
  const results = [];
  for (const c of corridors.listCorridors()) {
    try {
      const saved = corridors.saveSamples(c.id, await sampleCorridor(c, { key: TOMTOM_KEY }));
      results.push({ id: c.id, ...saved });
    } catch (error) {
      results.push({ id: c.id, error: error.message });
    }
  }
  console.log(`[corridors] sampled ${results.map((r) => `${r.id}:${r.ok ?? 'ERR'}`).join(' ')}`);
  return results;
}

async function seedCorridors() {
  if (!TOMTOM_KEY || corridors.listCorridors().length) return;
  for (const def of SEED_CORRIDORS) {
    try {
      corridors.saveCorridor(await resolveCorridor(def, { key: TOMTOM_KEY }));
      console.log(`[corridors] seeded ${def.id}`);
    } catch (error) {
      console.error(`[corridors] seed ${def.id} failed: ${error.message}`);
    }
  }
}

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('body too large');
  }
  return body ? JSON.parse(body) : {};
}
// With ADMIN_TOKEN set, reads of reports and health stay public (a corridor
// report is meant to be shared); everything that registers, deletes, samples
// or polls needs the token.
const PUBLIC_READ = /^\/(health|corridors(\/[a-z0-9-]+(\/(report|latest|series|compare))?)?)$/;
const authorized = (req) =>
  !ADMIN_TOKEN ||
  req.headers.authorization === `Bearer ${ADMIN_TOKEN}` ||
  (req.method === 'GET' && PUBLIC_READ.test(new URL(req.url, 'http://localhost').pathname));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, service.health());
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/assets') return json(res, 200, { assets: service.listAssets() });
    if (req.method === 'POST' && url.pathname === '/assets') {
      const body = await readJson(req);
      const list = Array.isArray(body) ? body : Array.isArray(body.assets) ? body.assets : [body];
      const saved = list.map((a) => service.upsertAsset(a));
      return json(res, 200, { assets: saved });
    }
    const removal = url.pathname.match(/^\/assets\/(.+)$/);
    if (req.method === 'DELETE' && removal)
      return json(res, service.removeAsset(decodeURIComponent(removal[1])) ? 200 : 404, { ok: true });
    if (req.method === 'GET' && url.pathname === '/matches')
      return json(res, 200, { matches: service.listMatches({ product: url.searchParams.get('product') || undefined, asset: url.searchParams.get('asset') || undefined }) });
    if (req.method === 'GET' && url.pathname === '/events') return json(res, 200, { events: service.listEvents() });
    if (req.method === 'POST' && url.pathname === '/poll') return json(res, 200, await service.poll());

    // ---- corridor monitor ----
    if (req.method === 'GET' && url.pathname === '/corridors')
      return json(res, 200, { tomtom: Boolean(TOMTOM_KEY), every_minutes: CORRIDOR_MINUTES, corridors: corridors.listCorridors().map((c) => ({ ...c, latest: corridors.latest(c.id).ts })) });
    if (req.method === 'POST' && url.pathname === '/corridors') {
      const def = await readJson(req);
      if (!def?.name || !def.from || !def.to) return json(res, 400, { error: 'name, from {lat,lon} and to {lat,lon} are required' });
      const resolved = await resolveCorridor(def, { key: TOMTOM_KEY });
      return json(res, 200, { corridor: corridors.saveCorridor(resolved) });
    }
    if (req.method === 'POST' && url.pathname === '/corridors/sample') return json(res, 200, { results: await sampleAllCorridors() });
    const cm = url.pathname.match(/^\/corridors\/([a-z0-9-]+)(?:\/(series|latest|compare|report|notes|sample))?$/);
    if (cm) {
      const corridor = corridors.getCorridor(cm[1]);
      if (!corridor) return json(res, 404, { error: 'corridor not found' });
      const sub = cm[2] || '';
      if (req.method === 'DELETE' && !sub) return json(res, 200, { ok: corridors.deleteCorridor(corridor.id) });
      if (req.method === 'POST' && sub === 'sample') return json(res, 200, corridors.saveSamples(corridor.id, await sampleCorridor(corridor, { key: TOMTOM_KEY })));
      if (req.method === 'POST' && sub === 'notes') {
        const note = await readJson(req);
        if (!note?.text) return json(res, 400, { error: 'text is required' });
        const at = note.at ? new Date(note.at) : new Date();
        if (Number.isNaN(at.getTime())) return json(res, 400, { error: 'at must be an ISO time' });
        corridors.addNote(corridor.id, at.toISOString(), note.text);
        return json(res, 200, { notes: corridors.listNotes(corridor.id) });
      }
      const hours = Math.max(1, Math.min(24 * 90, Number(url.searchParams.get('hours')) || 48));
      const to = new Date().toISOString();
      const from = new Date(Date.now() - hours * 3600_000).toISOString();
      if (sub === 'latest') return json(res, 200, corridors.latest(corridor.id));
      if (sub === 'series') return json(res, 200, { corridor: corridor.id, from, to, series: corridors.series(corridor.id, from, to) });
      const a = parseWindow(url.searchParams.get('a')), b = parseWindow(url.searchParams.get('b'));
      const comparison = a && b ? compareProfiles(profile(corridors.series(corridor.id, a.from, a.to)), profile(corridors.series(corridor.id, b.from, b.to))) : null;
      if (sub === 'compare') return json(res, 200, { corridor: corridor.id, a, b, comparison });
      if (sub === 'report' || !sub) {
        const html = renderReport({ corridor, series: corridors.series(corridor.id, from, to), latest: corridors.latest(corridor.id),
          notes: corridors.listNotes(corridor.id), comparison, windows: { hours, a: a?.label, b: b?.label } });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, error instanceof SyntaxError || /must|too large/.test(error.message) ? 400 : 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[alerts] listening on http://${HOST}:${PORT} · feeds from ${BASE_URL} · poll every ${POLL_MINUTES} min · data in ${DATA_DIR}`);
  service.poll().catch((e) => console.error('[alerts] first poll failed:', e.message));
  setInterval(() => service.poll().catch((e) => console.error('[alerts] poll failed:', e.message)), POLL_MINUTES * 60_000).unref();
  if (TOMTOM_KEY) {
    console.log(`[corridors] TomTom key present · sampling every ${CORRIDOR_MINUTES} min · reports at /corridors/<id>/report`);
    seedCorridors().then(sampleAllCorridors).catch((e) => console.error('[corridors] start failed:', e.message));
    setInterval(() => sampleAllCorridors().catch((e) => console.error('[corridors] sample failed:', e.message)), CORRIDOR_MINUTES * 60_000).unref();
  } else {
    console.log('[corridors] TOMTOM_API_KEY not set; corridor monitor idle');
  }
});
