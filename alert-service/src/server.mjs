import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createService } from './service.mjs';
import { createCorridorStore, profile, compareProfiles } from './corridor.mjs';
import { corridorDefinitions, resolveSections, sampleSections, createTravelStore } from './travel.mjs';
import { travelProfile, commuterTips, liveStatus } from './insights.mjs';
import { fetchIncidents, createIncidentStore, hotspots, CHENNAI_BBOX } from './incidents.mjs';
import { renderReport } from './report.mjs';
import { renderSummary } from './summary.mjs';
import { createGeocoder } from './geocode.mjs';
import { createStore } from './store.mjs';
import { lastCompletedWeek, weekBounds, summarizeWeek, summarizeCity, renderWeeklyHtml, renderWeeklyText } from './weekly.mjs';
import { sendMail } from './mail.mjs';

const PORT = Number(process.env.PORT || 4180);
// Loopback by default (a laptop); a hosted deployment sets HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
const BASE_URL = (process.env.GEV_BASE_URL || 'http://localhost:4173').replace(/\/$/, '');
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 10);
const DATA_DIR = process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TOMTOM_KEY = (process.env.TOMTOM_API_KEY || '').trim();
// 0 turns a recorder off (a laptop copy should not spend the same TomTom quota as the hosted one).
const CORRIDOR_MINUTES = Number(process.env.CORRIDOR_MINUTES ?? 15);
const INCIDENT_MINUTES = Number(process.env.INCIDENT_MINUTES ?? 15);
const INCIDENT_BBOX = (process.env.INCIDENT_BBOX || '').split(',').map(Number).filter(Number.isFinite);
// A hosted GEV behind its login gate: the same password opens its feeds to us.
const GEV_GATE_PASSWORD = (process.env.GEV_GATE_PASSWORD || '').trim();
// Weekly report: rendered at /weekly, emailed on REPORT_DAY (1 = Monday) from
// REPORT_HOUR IST when SMTP_USER/SMTP_PASS and REPORT_TO are set.
const REPORT_TO = (process.env.REPORT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
const SMTP = {
  host: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
  port: Number(process.env.SMTP_PORT || 465),
  user: (process.env.SMTP_USER || '').trim(),
  // Pasted secrets often carry a trailing newline or space.
  pass: (process.env.SMTP_PASS || '').trim(),
  from: process.env.REPORT_FROM || `Chennai roads · GEV <${(process.env.SMTP_USER || '').trim()}>`,
};
const REPORT_BASE_URL = (process.env.REPORT_BASE_URL || '').replace(/\/$/, '');
const REPORT_DAY = Number(process.env.REPORT_DAY ?? 1);
const REPORT_HOUR = Number(process.env.REPORT_HOUR ?? 7);
const DAY = 86_400_000;

const service = createService({ baseUrl: BASE_URL, dataDir: DATA_DIR, gateToken: GEV_GATE_PASSWORD });
const corridors = createCorridorStore(join(DATA_DIR, 'corridors.db'));
const travel = createTravelStore(corridors.db);
const incidents = createIncidentStore(corridors.db);
const geocoder = createGeocoder({ key: TOMTOM_KEY, store: createStore(DATA_DIR) });
const weeklyStore = createStore(join(DATA_DIR, 'weekly'));
const status = { corridors: null, incidents: null };

/** Context on the OMR record, added once. */
const SEED_NOTES = [
  { corridors: ['omr-south', 'omr-north'], at: '2026-09-24T02:30:00.000Z', text: 'GCTP trial: U-turns near Geetham, BSR Mall and World Trade Centre closed' },
  { corridors: ['omr-south', 'omr-north'], at: '2026-09-24T06:30:00.000Z', text: 'Trial reverted by midday' },
  { corridors: ['omr-south', 'omr-north'], at: '2026-09-24T07:56:00.000Z', text: 'Recording starts (after the reversal)' },
  { corridors: ['omr-south', 'omr-north'], at: '2026-09-29T08:00:00.000Z', text: 'Switched to section travel times' },
];
function seedNotes() {
  for (const n of SEED_NOTES)
    for (const id of n.corridors) {
      if (!corridors.getCorridor(id)) continue;
      if (corridors.listNotes(id).some((x) => x.text === n.text)) continue;
      corridors.addNote(id, n.at, n.text);
    }
}

const isSectioned = (c) => c?.definition?.version === 2 && Array.isArray(c.definition.sections);

/** Make sure every built-in road exists in its current, sectioned form. */
async function ensureCorridors() {
  if (!TOMTOM_KEY) return;
  for (const def of corridorDefinitions()) {
    const existing = corridors.getCorridor(def.id);
    if (isSectioned(existing) && JSON.stringify(existing.definition.stops) === JSON.stringify(def.stops)) continue;
    try {
      const resolved = await resolveSections(def, { key: TOMTOM_KEY });
      corridors.saveCorridor(resolved);
      console.log(`[corridors] ${existing ? 'upgraded' : 'added'} ${def.id} · ${resolved.lengthKm} km · ${resolved.definition.sections.length} sections${resolved.definition.warnings.length ? ` · ${resolved.definition.warnings.join('; ')}` : ''}`);
    } catch (error) {
      console.error(`[corridors] ${def.id} failed: ${error.message}`);
    }
  }
  seedNotes();
}

async function sampleAllCorridors() {
  if (!TOMTOM_KEY) return { skipped: 'TOMTOM_API_KEY not set' };
  const results = [];
  for (const c of corridors.listCorridors()) {
    if (!isSectioned(c)) continue;
    try {
      results.push({ id: c.id, ...travel.save(c.id, await sampleSections(c, { key: TOMTOM_KEY })) });
    } catch (error) {
      results.push({ id: c.id, error: error.message });
    }
  }
  status.corridors = { at: new Date().toISOString(), ok: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`) };
  console.log(`[corridors] sampled ${results.map((r) => `${r.id}:${r.error ? 'ERR' : 'ok'}`).join(' ')}`);
  return results;
}

async function pollIncidents() {
  if (!TOMTOM_KEY) return null;
  try {
    const list = await fetchIncidents({ key: TOMTOM_KEY, bbox: INCIDENT_BBOX.length === 4 ? INCIDENT_BBOX : CHENNAI_BBOX });
    status.incidents = { ...incidents.record(list), ok: true };
  } catch (error) {
    status.incidents = { at: new Date().toISOString(), ok: false, error: error.message };
    console.error('[incidents] poll failed:', error.message);
  }
  return status.incidents;
}

// ---- road insight helpers ----
const sectionedCorridors = () => corridors.listCorridors().filter(isSectioned);
function roadInsight(c) {
  const now = Date.now();
  const rows = travel.rows(c.id, new Date(now - 28 * DAY).toISOString(), new Date(now + 60_000).toISOString());
  const prof = travelProfile(rows, { sections: c.definition.sections.length });
  const latest = travel.latest(c.id);
  return { corridor: c, profile: prof, latest, status: liveStatus(c, latest, prof), ...commuterTips(c, prof) };
}
let summaryCache = { at: 0, html: '' };
function summaryHtml() {
  if (Date.now() - summaryCache.at < 60_000 && summaryCache.html) return summaryCache.html;
  const order = corridorDefinitions().map((d) => d.id);
  const roads = sectionedCorridors()
    .sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99))
    .map(roadInsight);
  const since30 = new Date(Date.now() - 30 * DAY).toISOString();
  const week = weekBounds(lastCompletedWeek(Date.now() + 7 * DAY).key); // the current week
  const html = renderSummary({
    roads,
    events: service.rawEvents(),
    incidentsNow: incidents.current(),
    hotspots: hotspots(incidents.since(since30), { limit: 10 }),
    weekCounts: week ? incidents.counts(week.start) : [],
    incidentsSince: incidents.firstSeen(),
    feedsOk: Object.values(service.feedStatus() || {}).every((f) => f.ok),
  });
  summaryCache = { at: Date.now(), html };
  return html;
}

// ---- weekly report and mail ----
function weeklyReport(week) {
  const list = sectionedCorridors();
  const order = corridorDefinitions().map((d) => d.id);
  list.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  const summaries = list.map((corridor) => summarizeWeek({ travel, corridor, week }));
  const city = summarizeCity({ incidents, week });
  const notes = [...new Map(list.flatMap((c) => corridors.listNotes(c.id)).filter((n) => n.at >= week.start && n.at < week.end).map((n) => [n.text, n])).values()];
  weeklyStore.write(week.key, { week, generatedAt: new Date().toISOString(), summaries, city });
  return { summaries, city, notes };
}

const mailConfigured = () => Boolean(SMTP.user && SMTP.pass && REPORT_TO.length);
const mailConfigHash = () => createHash('sha256').update([SMTP.host, SMTP.port, SMTP.user, SMTP.pass, REPORT_TO.join(',')].join('|')).digest('hex').slice(0, 12);
const mailState = () => weeklyStore.read('state', {});

/** Build the week's report and, when mail is configured, send it. */
async function runWeeklyReport({ week = lastCompletedWeek(), send = true } = {}) {
  const { summaries, city, notes } = weeklyReport(week);
  const result = { week: week.key, corridors: summaries.length, sent: false, to: REPORT_TO };
  if (send && !mailConfigured()) result.skipped = 'SMTP_USER, SMTP_PASS and REPORT_TO are not all set';
  else if (send && summaries.length) {
    const state = mailState();
    const attempt = { ...state, lastAttemptAt: new Date().toISOString(), configHash: mailConfigHash() };
    try {
      const subject = `Chennai roads · week ${week.key} (${week.label})`;
      const { accepted } = await sendMail({ ...SMTP, to: REPORT_TO, subject,
        html: renderWeeklyHtml({ summaries, city, notes, week, baseUrl: REPORT_BASE_URL }), text: renderWeeklyText({ summaries, city, week, baseUrl: REPORT_BASE_URL }) });
      result.sent = true;
      result.accepted = accepted;
      weeklyStore.write('state', { ...attempt, lastSent: week.key, lastSentAt: attempt.lastAttemptAt, accepted, lastError: null, failures: 0, failedWeek: null });
    } catch (error) {
      const sameWeek = state.failedWeek === week.key && state.configHash === attempt.configHash;
      weeklyStore.write('state', { ...attempt, lastError: error.message, authFailed: /\b535\b|auth/i.test(error.message), failures: (sameWeek ? state.failures || 0 : 0) + 1, failedWeek: week.key });
      result.error = error.message;
    }
  }
  console.log(`[weekly] ${week.key}: ${summaries.length} corridor(s)${result.sent ? ` emailed to ${result.accepted.join(', ')}` : result.error ? ` NOT sent: ${result.error}` : result.skipped ? ` (not emailed: ${result.skipped})` : ''}`);
  return result;
}

/**
 * Once a minute: on report day from report hour, send last week's report
 * if it has not gone out. After a failure wait 30 minutes; after a login
 * failure (or three failures) stop until the settings change, so a wrong
 * password cannot hammer the mail host into locking the account.
 */
function weeklyTick() {
  const ist = new Date(Date.now() + 330 * 60_000);
  if (ist.getUTCDay() !== REPORT_DAY || ist.getUTCHours() < REPORT_HOUR) return;
  if (!mailConfigured()) return;
  const week = lastCompletedWeek();
  const state = mailState();
  if (state.lastSent === week.key) return;
  if (state.failedWeek === week.key && state.configHash === mailConfigHash()) {
    if (state.authFailed || (state.failures || 0) >= 3) return;
    if (Date.now() - Date.parse(state.lastAttemptAt || 0) < 30 * 60_000) return;
  }
  runWeeklyReport({ week }).catch((e) => console.error('[weekly] failed:', e.message));
}

function mailHealth() {
  const s = mailState();
  return {
    configured: mailConfigured(),
    host: SMTP.host,
    port: SMTP.port,
    recipients: REPORT_TO.length,
    schedule: `day ${REPORT_DAY} (1 = Monday) from ${String(REPORT_HOUR).padStart(2, '0')}:00 IST`,
    lastSent: s.lastSent || null,
    lastSentAt: s.lastSentAt || null,
    lastAttemptAt: s.lastAttemptAt || null,
    lastError: s.lastError || null,
    waitingForNewSettings: Boolean(s.lastError && s.configHash === mailConfigHash() && (s.authFailed || (s.failures || 0) >= 3)),
  };
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
  const from = new Date(`${m[1]}T00:00:00+05:30`).toISOString();
  const to = new Date(new Date(`${m[2]}T00:00:00+05:30`).getTime() + DAY).toISOString();
  return { from, to, label: `${m[1]} → ${m[2]}` };
};

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const html = (res, body, cache = 'no-store') => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache });
  res.end(body);
};
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('body too large');
  }
  return body ? JSON.parse(body) : {};
}
// With ADMIN_TOKEN set, the public pages and reads of recorded data stay
// open (they are meant to be shared and cost no quota); everything that
// registers, deletes, samples, polls or sends needs the token.
const PUBLIC_READ = /^\/(|summary|health|incidents|weekly(\/\d{4}-W\d{2}(\.json)?)?|corridors(\/[a-z0-9-]+(\/(report|latest|series|compare|travel|tips))?)?)$/;
const authorized = (req) =>
  !ADMIN_TOKEN ||
  req.headers.authorization === `Bearer ${ADMIN_TOKEN}` ||
  (req.method === 'GET' && PUBLIC_READ.test(new URL(req.url, 'http://localhost').pathname));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health')
      return json(res, 200, { ...service.health(), corridors: { every_minutes: CORRIDOR_MINUTES, count: sectionedCorridors().length, last: status.corridors }, incidents: { every_minutes: INCIDENT_MINUTES, last: status.incidents }, mail: mailHealth() });
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/summary')) return html(res, summaryHtml(), 'public, max-age=60');
    if (req.method === 'GET' && url.pathname === '/incidents') {
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 30));
      return json(res, 200, { current: incidents.current(), hotspots: hotspots(incidents.since(new Date(Date.now() - days * DAY).toISOString()), { limit: 25 }), since: incidents.firstSeen(), last: status.incidents });
    }
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
    if (req.method === 'POST' && url.pathname === '/incidents/poll') return json(res, 200, await pollIncidents());

    // ---- weekly report ----
    if (req.method === 'POST' && url.pathname === '/weekly/send') {
      const week = url.searchParams.get('week') ? weekBounds(url.searchParams.get('week')) : lastCompletedWeek();
      if (!week) return json(res, 400, { error: 'week must look like 2026-W39' });
      return json(res, 200, await runWeeklyReport({ week, send: url.searchParams.get('send') !== '0' }));
    }
    const wm = url.pathname.match(/^\/weekly(?:\/(\d{4}-W\d{2}))?(\.json)?$/);
    if (req.method === 'GET' && wm) {
      const week = wm[1] ? weekBounds(wm[1]) : lastCompletedWeek();
      if (!week) return json(res, 400, { error: 'week must look like 2026-W39' });
      const { summaries, city, notes } = weeklyReport(week);
      if (wm[2]) return json(res, 200, { week, summaries, city, notes });
      return html(res, renderWeeklyHtml({ summaries, city, notes, week, baseUrl: REPORT_BASE_URL }));
    }

    // ---- corridors ----
    if (req.method === 'GET' && url.pathname === '/corridors')
      return json(res, 200, {
        tomtom: Boolean(TOMTOM_KEY),
        every_minutes: CORRIDOR_MINUTES,
        corridors: corridors.listCorridors().map((c) => ({ id: c.id, name: c.name, lengthKm: c.lengthKm, sectioned: isSectioned(c), sections: c.definition?.sections || null, warnings: c.definition?.warnings || [], stops: c.points, latest: travel.latest(c.id).ts, samples: travel.count(c.id) })),
      });
    if (req.method === 'POST' && url.pathname === '/corridors') {
      const def = await readJson(req);
      const stops = Array.isArray(def?.stops) ? def.stops : def?.from && def?.to ? [{ name: 'Start', ...def.from }, ...(def.via || []).map((v, i) => ({ name: `Via ${i + 1}`, ...v })), { name: 'End', ...def.to }] : null;
      if (!def?.name || !stops || stops.length < 2 || stops.some((s) => !Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lon))))
        return json(res, 400, { error: 'name and stops [{name, lat, lon}, ...] (at least two) are required' });
      const id = String(def.id || def.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      const resolved = await resolveSections({ id, name: String(def.name).slice(0, 120), road: def.road || id, stops: stops.map((s) => ({ name: String(s.name || '').slice(0, 60), lat: Number(s.lat), lon: Number(s.lon) })) }, { key: TOMTOM_KEY });
      return json(res, 200, { corridor: corridors.saveCorridor(resolved) });
    }
    if (req.method === 'POST' && url.pathname === '/corridors/sample') return json(res, 200, { results: await sampleAllCorridors() });
    const cm = url.pathname.match(/^\/corridors\/([a-z0-9-]+)(?:\/(series|latest|compare|report|notes|sample|travel|tips))?$/);
    if (cm) {
      const corridor = corridors.getCorridor(cm[1]);
      if (!corridor) return json(res, 404, { error: 'corridor not found' });
      const sub = cm[2] || '';
      if (req.method === 'DELETE' && !sub) return json(res, 200, { ok: corridors.deleteCorridor(corridor.id) });
      if (req.method === 'POST' && sub === 'sample') {
        if (!isSectioned(corridor)) return json(res, 409, { error: 'corridor predates section sampling; re-add it with stops' });
        return json(res, 200, travel.save(corridor.id, await sampleSections(corridor, { key: TOMTOM_KEY })));
      }
      if (req.method === 'POST' && sub === 'notes') {
        const note = await readJson(req);
        if (!note?.text) return json(res, 400, { error: 'text is required' });
        const at = note.at ? new Date(note.at) : new Date();
        if (Number.isNaN(at.getTime())) return json(res, 400, { error: 'at must be an ISO time' });
        corridors.addNote(corridor.id, at.toISOString(), note.text);
        summaryCache.at = 0;
        return json(res, 200, { notes: corridors.listNotes(corridor.id) });
      }
      const hours = Math.max(1, Math.min(24 * 90, Number(url.searchParams.get('hours')) || 48));
      const to = new Date(Date.now() + 60_000).toISOString();
      const from = new Date(Date.now() - hours * 3600_000).toISOString();
      if (sub === 'latest') return json(res, 200, isSectioned(corridor) ? travel.latest(corridor.id) : corridors.latest(corridor.id));
      if (sub === 'travel') return json(res, 200, { corridor: corridor.id, sections: corridor.definition?.sections || [], from, to, totals: travel.totals(corridor.id, from, to), latest: travel.latest(corridor.id) });
      if (sub === 'tips') {
        if (!isSectioned(corridor)) return json(res, 409, { error: 'corridor predates section sampling' });
        const r = roadInsight(corridor);
        return json(res, 200, { corridor: corridor.id, status: r.status, tips: r.tips, enoughData: r.enoughData, daysRecorded: r.daysRecorded, weekday: r.profile.weekday, weekend: r.profile.weekend });
      }
      // Legacy point-speed series (recorded 24–29 Sep 2026 before section sampling).
      if (sub === 'series') return json(res, 200, { corridor: corridor.id, from, to, series: corridors.series(corridor.id, from, to) });
      const a = parseWindow(url.searchParams.get('a')), b = parseWindow(url.searchParams.get('b'));
      const comparison = a && b ? compareProfiles(profile(corridors.series(corridor.id, a.from, a.to)), profile(corridors.series(corridor.id, b.from, b.to))) : null;
      if (sub === 'compare') return json(res, 200, { corridor: corridor.id, a, b, comparison });
      if (sub === 'report' || !sub) {
        const insight = isSectioned(corridor) ? roadInsight(corridor) : null;
        return html(res, renderReport({
          corridor,
          series: corridors.series(corridor.id, from, to),
          latest: corridors.latest(corridor.id),
          notes: corridors.listNotes(corridor.id),
          comparison,
          windows: { hours, a: a?.label, b: b?.label },
          travel: insight && { totals: travel.totals(corridor.id, from, to), latest: insight.latest, status: insight.status, tips: insight.tips, profile: insight.profile, jams: travel.jams(corridor.id, from, to) },
        }));
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, error instanceof SyntaxError || /must|too large|required/.test(error.message) ? 400 : 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[alerts] listening on http://${HOST}:${PORT} · feeds from ${BASE_URL} · poll every ${POLL_MINUTES} min · data in ${DATA_DIR}`);
  service.poll().catch((e) => console.error('[alerts] first poll failed:', e.message));
  setInterval(() => service.poll().catch((e) => console.error('[alerts] poll failed:', e.message)), POLL_MINUTES * 60_000).unref();
  if (!TOMTOM_KEY) {
    console.log('[corridors] TOMTOM_API_KEY not set; road and incident recording idle');
  } else {
    if (CORRIDOR_MINUTES > 0) {
      console.log(`[corridors] section travel times every ${CORRIDOR_MINUTES} min · public page at /`);
      ensureCorridors().then(sampleAllCorridors).catch((e) => console.error('[corridors] start failed:', e.message));
      setInterval(() => sampleAllCorridors().catch((e) => console.error('[corridors] sample failed:', e.message)), CORRIDOR_MINUTES * 60_000).unref();
    } else console.log('[corridors] recording off (CORRIDOR_MINUTES=0)');
    if (INCIDENT_MINUTES > 0) {
      console.log(`[incidents] Chennai incidents every ${INCIDENT_MINUTES} min`);
      pollIncidents();
      setInterval(pollIncidents, INCIDENT_MINUTES * 60_000).unref();
    } else console.log('[incidents] recording off (INCIDENT_MINUTES=0)');
  }
  const mail = mailHealth();
  console.log(`[weekly] report at /weekly · ${mail.configured ? `emailed to ${REPORT_TO.length} recipient(s) via ${SMTP.host}:${SMTP.port}, ${mail.schedule}${mail.waitingForNewSettings ? ` · PAUSED after: ${mail.lastError}` : ''}` : 'email off (set SMTP_USER, SMTP_PASS, REPORT_TO)'}`);
  setInterval(weeklyTick, 60_000).unref();
});
