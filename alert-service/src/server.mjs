import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createService } from './service.mjs';
import { createCorridorStore, resolveCorridor, sampleCorridor, profile, compareProfiles, SEED_CORRIDORS } from './corridor.mjs';
import { renderReport } from './report.mjs';
import { createGeocoder } from './geocode.mjs';
import { createStore } from './store.mjs';
import { lastCompletedWeek, weekBounds, summarizeWeek, renderWeeklyHtml, renderWeeklyText } from './weekly.mjs';
import { sendMail } from './mail.mjs';

const PORT = Number(process.env.PORT || 4180);
// Loopback by default (a laptop); a hosted deployment sets HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = (process.env.GEV_BASE_URL || 'http://localhost:4173').replace(/\/$/, '');
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 10);
const DATA_DIR = process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TOMTOM_KEY = (process.env.TOMTOM_API_KEY || '').trim();
const CORRIDOR_MINUTES = Number(process.env.CORRIDOR_MINUTES || 15);
// A hosted GEV behind its login gate: the same password opens its feeds to us.
const GEV_GATE_PASSWORD = (process.env.GEV_GATE_PASSWORD || '').trim();
// Weekly corridor report: rendered at /weekly, emailed on REPORT_DAY (1 = Monday)
// at REPORT_HOUR IST when SMTP_USER/SMTP_PASS and REPORT_TO are set.
const REPORT_TO = (process.env.REPORT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
const SMTP = { host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT || 465), user: (process.env.SMTP_USER || '').trim(), pass: process.env.SMTP_PASS || '', from: process.env.REPORT_FROM || `GEV corridor monitor <${(process.env.SMTP_USER || '').trim()}>` };
const REPORT_BASE_URL = (process.env.REPORT_BASE_URL || '').replace(/\/$/, '');
const REPORT_DAY = Number(process.env.REPORT_DAY ?? 1);
const REPORT_HOUR = Number(process.env.REPORT_HOUR ?? 7);

const service = createService({ baseUrl: BASE_URL, dataDir: DATA_DIR, gateToken: GEV_GATE_PASSWORD });
const corridors = createCorridorStore(join(DATA_DIR, 'corridors.db'));
const geocoder = createGeocoder({ key: TOMTOM_KEY, store: createStore(DATA_DIR) });
const weeklyStore = createStore(join(DATA_DIR, 'weekly'));

/** Summaries for every corridor for one week; saved so past weeks stay readable. */
function weeklySummaries(week) {
  const summaries = corridors.listCorridors().map((corridor) => summarizeWeek({ store: corridors, corridor, week }));
  weeklyStore.write(week.key, { week, generatedAt: new Date().toISOString(), summaries });
  return summaries;
}

const mailConfigured = () => Boolean(SMTP.user && SMTP.pass && REPORT_TO.length);

/** Build the week's report and, when mail is configured, send it. */
async function runWeeklyReport({ week = lastCompletedWeek(), send = true } = {}) {
  const summaries = weeklySummaries(week);
  const result = { week: week.key, corridors: summaries.length, sent: false, to: REPORT_TO };
  if (send && mailConfigured() && summaries.length) {
    const subject = `OMR corridor report · week ${week.key} (${week.label})`;
    const { accepted } = await sendMail({ ...SMTP, to: REPORT_TO, subject,
      html: renderWeeklyHtml({ summaries, week, baseUrl: REPORT_BASE_URL }), text: renderWeeklyText({ summaries, week, baseUrl: REPORT_BASE_URL }) });
    result.sent = true;
    result.accepted = accepted;
    weeklyStore.write('state', { lastSent: week.key, at: new Date().toISOString(), accepted });
  } else if (send && !mailConfigured()) result.skipped = 'SMTP_USER, SMTP_PASS and REPORT_TO are not all set';
  console.log(`[weekly] ${week.key}: ${summaries.length} corridor(s)${result.sent ? ` emailed to ${result.accepted.join(', ')}` : result.skipped ? ` (not emailed: ${result.skipped})` : ''}`);
  return result;
}

/** Once a minute: is it report time in IST, and has this week's report gone out? */
function weeklyTick() {
  const ist = new Date(Date.now() + 330 * 60_000);
  if (ist.getUTCDay() !== REPORT_DAY || ist.getUTCHours() !== REPORT_HOUR) return;
  const week = lastCompletedWeek();
  if (weeklyStore.read('state', {}).lastSent === week.key) return;
  if (!mailConfigured()) return;
  runWeeklyReport({ week }).catch((e) => console.error('[weekly] send failed:', e.message));
}

/**
 * Products that only know a site's city send it without coordinates; the
 * service geocodes it (TomTom, cached) before registering. An asset that
 * cannot be placed is reported back, never registered somewhere wrong.
 */
async function placeAssets(list) {
  const placed = [], failed = [];
  for (const a of list) {
    const hasCoords = a && a.latitude != null && a.latitude !== '' && a.longitude != null && a.longitude !== '';
    if (hasCoords || !a?.city) {
      placed.push(a);
      continue;
    }
    try {
      const hit = await geocoder.geocode(a.city, { country: a.country || 'IN' });
      if (hit) placed.push({ ...a, latitude: hit.latitude, longitude: hit.longitude, geocoded: hit.label });
      else failed.push({ id: a.id, product: a.product, error: `could not geocode '${a.city}'` });
    } catch (error) {
      failed.push({ id: a.id, product: a.product, error: error.message });
    }
  }
  return { placed, failed };
}

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
const PUBLIC_READ = /^\/(health|weekly(\/\d{4}-W\d{2}(\.json)?)?|corridors(\/[a-z0-9-]+(\/(report|latest|series|compare))?)?)$/;
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
      const { placed, failed } = await placeAssets(list);
      const saved = [], rejected = [...failed];
      for (const a of placed) {
        try {
          const asset = service.upsertAsset(a);
          saved.push(a.geocoded ? { ...asset, geocoded: a.geocoded } : asset);
        } catch (error) {
          rejected.push({ id: a?.id, product: a?.product, error: error.message });
        }
      }
      return json(res, 200, { assets: saved, rejected });
    }
    if (req.method === 'GET' && url.pathname === '/geocode') {
      const hit = await geocoder.geocode(url.searchParams.get('q'), { country: url.searchParams.get('country') || 'IN' });
      return json(res, hit ? 200 : 404, hit || { error: 'no match' });
    }
    const removal = url.pathname.match(/^\/assets\/(.+)$/);
    if (req.method === 'DELETE' && removal)
      return json(res, service.removeAsset(decodeURIComponent(removal[1])) ? 200 : 404, { ok: true });
    if (req.method === 'GET' && url.pathname === '/matches')
      return json(res, 200, { matches: service.listMatches({ product: url.searchParams.get('product') || undefined, asset: url.searchParams.get('asset') || undefined }) });
    if (req.method === 'GET' && url.pathname === '/events') return json(res, 200, { events: service.listEvents() });
    if (req.method === 'POST' && url.pathname === '/poll') return json(res, 200, await service.poll());

    // ---- weekly corridor report ----
    if (req.method === 'POST' && url.pathname === '/weekly/send') {
      const week = url.searchParams.get('week') ? weekBounds(url.searchParams.get('week')) : lastCompletedWeek();
      if (!week) return json(res, 400, { error: 'week must look like 2026-W39' });
      return json(res, 200, await runWeeklyReport({ week, send: url.searchParams.get('send') !== '0' }));
    }
    const wm = url.pathname.match(/^\/weekly(?:\/(\d{4}-W\d{2}))?(\.json)?$/);
    if (req.method === 'GET' && wm) {
      const week = wm[1] ? weekBounds(wm[1]) : lastCompletedWeek();
      if (!week) return json(res, 400, { error: 'week must look like 2026-W39' });
      const summaries = weeklySummaries(week);
      if (wm[2]) return json(res, 200, { week, summaries });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderWeeklyHtml({ summaries, week, baseUrl: REPORT_BASE_URL }));
    }

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
    console.log(`[weekly] report at /weekly · ${mailConfigured() ? `emailed to ${REPORT_TO.join(', ')} every week, day ${REPORT_DAY} ${String(REPORT_HOUR).padStart(2, '0')}:00 IST` : 'email off (set SMTP_USER, SMTP_PASS, REPORT_TO)'}`);
    setInterval(weeklyTick, 60_000).unref();
  } else {
    console.log('[corridors] TOMTOM_API_KEY not set; corridor monitor idle');
  }
});
