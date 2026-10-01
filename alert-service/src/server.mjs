import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { createService } from './service.mjs';
import { createCorridorStore, profile, compareProfiles } from './corridor.mjs';
import { corridorDefinitions, resolveSections, sampleSections, createTravelStore } from './travel.mjs';
import { travelProfile, commuterTips, liveStatus, crossRoadNotes, daysCovered, confidenceOf, sourceOf } from './insights.mjs';
import { fetchIncidents, createIncidentStore, recurringJams, safetySpots, CHENNAI_BBOX } from './incidents.mjs';
import { fetchRain, createWeatherStore, RAIN_POINTS } from './weather.mjs';
import { createRollupStore, daysToRoll, rollupCsv } from './rollup.mjs';
import { renderMethodology } from './methodology.mjs';
import { googleDrive, compareDrives, createCrossCheckStore, parseHours, istHour, istMonth, formalReadiness } from './crosscheck.mjs';
import { createDriveStore, analyzeDrive, cleanTrack, errorOf } from './drives.mjs';
import { renderDriveApp } from './driveapp.mjs';
import { buildGeoFeed, buildHistory } from './roadfeed.mjs';
import { evaluateChange, impactText, createInterventionStore, controlsFor } from './impact.mjs';
import { renderImpactPage } from './impactpage.mjs';
import { forecastRoad, createForecastStore } from './forecast.mjs';
import { rainEffect } from './raineffect.mjs';
import { briefSection, renderBriefs } from './brief.mjs';
import { renderReport } from './report.mjs';
import { renderSummary } from './summary.mjs';
import { createGeocoder } from './geocode.mjs';
import { createStore } from './store.mjs';
import { lastCompletedWeek, weekBounds, summarizeWeek, summarizeCity, addCrossRoadNotes, renderWeeklyHtml, renderWeeklyText } from './weekly.mjs';
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
// Pasted settings often carry a trailing newline or space, or quote marks.
const cleanSetting = (v) => {
  const t = String(v || '').trim();
  return /^(["']).*\1$/.test(t) && t.length >= 2 ? t.slice(1, -1) : t;
};
const RAW_PASS = process.env.SMTP_PASS || '';
const SMTP = {
  host: cleanSetting(process.env.SMTP_HOST) || 'smtp.gmail.com',
  port: Number(cleanSetting(process.env.SMTP_PORT) || 465),
  user: cleanSetting(process.env.SMTP_USER),
  pass: cleanSetting(RAW_PASS),
  from: process.env.REPORT_FROM || `Chennai roads · GEV <${cleanSetting(process.env.SMTP_USER)}>`,
};
/** What the service does with the mail settings, without revealing the password. */
const mailSettingsReport = () => ({
  host: SMTP.host,
  port: SMTP.port,
  user: SMTP.user,
  userLooksLikeAnEmail: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(SMTP.user),
  passwordCharacters: SMTP.pass.length,
  passwordHadSpacesOrNewlinesAtTheEnds: RAW_PASS !== RAW_PASS.trim(),
  passwordHadQuoteMarks: RAW_PASS.trim() !== SMTP.pass,
  passwordHasNonAsciiCharacters: /[^\x20-\x7e]/.test(SMTP.pass),
  recipients: REPORT_TO,
});
const REPORT_BASE_URL = (process.env.REPORT_BASE_URL || '').replace(/\/$/, '');
const REPORT_DAY = Number(process.env.REPORT_DAY ?? 1);
const REPORT_HOUR = Number(process.env.REPORT_HOUR ?? 7);
const DAY = 86_400_000;
// TomTom's terms limit how long downloaded traffic content may be kept. 0 keeps raw readings;
// a positive number deletes raw readings older than that many days once they are rolled up.
const RAW_RETENTION_DAYS = Number(process.env.RAW_RETENTION_DAYS || 0);
// The slot export stays behind the admin token until TomTom confirms sharing derived data.
const EXPORT_PUBLIC = /^(1|true|yes)$/i.test(String(process.env.EXPORT_PUBLIC || ''));
const RAIN_MINUTES = Number(process.env.RAIN_MINUTES ?? 60);
// Second source: Google Routes, compared and discarded (see src/crosscheck.mjs).
const GOOGLE_ROUTES_KEY = (process.env.GOOGLE_ROUTES_API_KEY || '').trim();
const GOOGLE_CHECK_HOURS = parseHours(process.env.GOOGLE_CHECK_HOURS || '3,6-23');
const GOOGLE_MONTHLY_CAP = Number(process.env.GOOGLE_MONTHLY_CAP || 4800);

const service = createService({ baseUrl: BASE_URL, dataDir: DATA_DIR, gateToken: GEV_GATE_PASSWORD });
const corridors = createCorridorStore(join(DATA_DIR, 'corridors.db'));
const travel = createTravelStore(corridors.db);
const incidents = createIncidentStore(corridors.db);
const geocoder = createGeocoder({ key: TOMTOM_KEY, store: createStore(DATA_DIR) });
const weeklyStore = createStore(join(DATA_DIR, 'weekly'));
const weather = createWeatherStore(corridors.db);
const rollups = createRollupStore(corridors.db);
const crosschecks = createCrossCheckStore(corridors.db);
const drives = createDriveStore(corridors.db);
const interventions = createInterventionStore(corridors.db);
const forecasts = createForecastStore(corridors.db);
// The one change on record so far; recording began after it ended, so it cannot be evaluated (the page says so).
interventions.upsert({ id: 'omr-uturn-trial-2026-09-24', title: 'GCTP trial: U-turns near Geetham, BSR Mall and World Trade Centre closed', corridors: ['omr-south', 'omr-north'], start: '2026-09-24T02:30:00.000Z', end: '2026-09-24T06:30:00.000Z', source: 'https://www.dtnext.in/news/chennai/gctps-diversion-experiment-chokes-rajiv-gandhi-salai-reverses-changes' });
/** Google's prediction for a drive in progress: held in memory only, discarded at the finish (its terms forbid storing it). */
const pendingGoogle = new Map();
const DRIVE_KEYS = [GEV_GATE_PASSWORD, ADMIN_TOKEN].filter(Boolean);
const driveFailures = new Map();
function driveKeyOk(req) {
  const given = Buffer.from(String(req.headers['x-drive-key'] || ''));
  return DRIVE_KEYS.some((k) => { const want = Buffer.from(k); return want.length === given.length && timingSafeEqual(want, given); });
}
function driveThrottled(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
  const recent = (driveFailures.get(ip) || []).filter((t) => Date.now() - t < 15 * 60_000);
  driveFailures.set(ip, recent);
  return { ip, blocked: recent.length >= 10, fail: () => driveFailures.set(ip, [...recent, Date.now()]) };
}
const status = { corridors: null, incidents: null, rain: null, rollup: null, crosscheck: null };

/** Context on the OMR record, added once. */
const SEED_NOTES = [
  { corridors: ['omr-south', 'omr-north'], at: '2026-09-24T02:30:00.000Z', text: 'GCTP trial: U-turns near Geetham, BSR Mall and World Trade Centre closed' },
  { corridors: ['omr-south', 'omr-north'], at: '2026-09-24T06:30:00.000Z', text: 'Trial reverted by midday' },
  { corridors: ['omr-south', 'omr-north'], at: '2026-09-24T07:56:00.000Z', text: 'Recording starts (after the reversal)' },
  { corridors: ['omr-south', 'omr-north'], at: '2026-09-29T08:00:00.000Z', text: 'Switched to section travel times' },
  // Tamil Nadu public holidays (state list, 2026), on every road.
  { corridors: null, at: '2026-10-01T18:30:00.000Z', text: 'Public holiday: Gandhi Jayanti' },
  { corridors: null, at: '2026-10-18T18:30:00.000Z', text: 'Public holiday: Ayudha Pooja' },
  { corridors: null, at: '2026-10-19T18:30:00.000Z', text: 'Public holiday: Vijayadasami' },
  { corridors: null, at: '2026-11-07T18:30:00.000Z', text: 'Deepavali (Sunday)' },
  { corridors: null, at: '2026-12-24T18:30:00.000Z', text: 'Public holiday: Christmas' },
];
function seedNotes() {
  const global = corridors.db.prepare('SELECT text FROM notes WHERE corridor_id IS NULL').all().map((r) => r.text);
  for (const n of SEED_NOTES.filter((x) => !x.corridors)) if (!global.includes(n.text)) corridors.addNote(null, n.at, n.text);
  for (const n of SEED_NOTES.filter((x) => x.corridors))
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
  crossCheckIfDue().catch((e) => console.error('[crosscheck] failed:', e.message));
  try {
    forecastRound();
  } catch (error) {
    console.error('[forecast] failed:', error.message);
  }
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

async function pollRain() {
  try {
    const rows = await fetchRain({ pastDays: 3 });
    status.rain = { at: new Date().toISOString(), ok: true, hours: weather.record(rows) };
  } catch (error) {
    status.rain = { at: new Date().toISOString(), ok: false, error: error.message };
    console.error('[rain] poll failed:', error.message);
  }
}

/** Roll finished IST days up into daily slot summaries; then apply raw retention, if set. */
function rollUp() {
  let slots = 0, days = 0;
  for (const corridor of sectionedCorridors()) {
    const first = corridors.db.prepare('SELECT MIN(ts) AS ts FROM route_samples WHERE corridor_id = ?').get(corridor.id)?.ts;
    const point = corridor.definition?.road && RAIN_POINTS[corridor.definition.road] ? corridor.definition.road : null;
    for (const day of daysToRoll({ firstTs: first, rolled: new Set(rollups.days(corridor.id)) })) {
      const bounds = { start: new Date(Date.parse(`${day}T00:00:00+05:30`)).toISOString(), end: new Date(Date.parse(`${day}T00:00:00+05:30`) + DAY).toISOString() };
      slots += rollups.rollDay({ corridor, day, travel, rain: point ? weather.series(point, bounds.start, bounds.end) : null });
      days++;
    }
  }
  const purge = rollups.purgeRaw(RAW_RETENTION_DAYS, sectionedCorridors().map((c) => c.id));
  status.rollup = { at: new Date().toISOString(), days, slots, purged: purge.deleted };
  return status.rollup;
}

/**
 * Once per scheduled IST hour, right after a TomTom round, ask Google for
 * the same drives and keep only the comparison outcome.
 */
let lastCrossCheckHour = null;
/** The road's recorded night-time drive, the shared yardstick for congestion. */
function nightFor(c) {
  try {
    return roadInsight(c).baseline?.minutes ?? null;
  } catch {
    return null;
  }
}
async function crossCheckIfDue({ force = false } = {}) {
  if (!GOOGLE_ROUTES_KEY) return null;
  const now = Date.now();
  const hourKey = new Date(now + 330 * 60_000).toISOString().slice(0, 13);
  if (!force && (!GOOGLE_CHECK_HOURS.has(istHour(now)) || lastCrossCheckHour === hourKey)) return null;
  const last = crosschecks.lastHourKey();
  // A round that only produced errors does not count as done: retry it on the next TomTom round.
  if (!force && last && new Date(Date.parse(last) + 330 * 60_000).toISOString().slice(0, 13) === hourKey && !crosschecks.onlyErrorsAt(last)) return (lastCrossCheckHour = hourKey), null;
  lastCrossCheckHour = hourKey;
  const used = crosschecks.callsInMonth(istMonth(now));
  const list = sectionedCorridors();
  if (used + list.length > GOOGLE_MONTHLY_CAP) {
    status.crosscheck = { at: new Date(now).toISOString(), skipped: `monthly cap reached (${used} of ${GOOGLE_MONTHLY_CAP})` };
    return status.crosscheck;
  }
  const ts = new Date(now).toISOString();
  const outcomes = [];
  let firstError = null;
  for (const c of list) {
    const tomtom = travel.latest(c.id);
    if (!tomtom.ts || now - Date.parse(tomtom.ts) > 10 * 60_000) continue; // no TomTom reading for this moment
    try {
      const g = await googleDrive(c, { key: GOOGLE_ROUTES_KEY });
      const r = compareDrives(g, tomtom, c.lengthKm, { nightMinutes: nightFor(c) });
      crosschecks.record(c.id, ts, tomtom.ts, r);
      outcomes.push(`${c.id}:${r.outcome}${r.note ? `(${r.note})` : ''}`);
    } catch (error) {
      crosschecks.record(c.id, ts, tomtom.ts, { outcome: 'error', error: error.message.slice(0, 200) });
      outcomes.push(`${c.id}:error`);
      firstError ??= error.message.slice(0, 300);
      if (/HTTP 4\d\d/.test(error.message)) break; // a request or key problem repeats for every road: one call is enough
    }
  }
  status.crosscheck = { at: ts, outcomes, ...(firstError ? { error: firstError } : {}), monthCalls: crosschecks.callsInMonth(istMonth(now)), cap: GOOGLE_MONTHLY_CAP };
  // If this round failed, let the next TomTom round in the same hour try again.
  if (outcomes.length && outcomes.every((o) => o.endsWith(':error'))) lastCrossCheckHour = null;
  console.log(`[crosscheck] ${outcomes.join(' ')}`);
  return status.crosscheck;
}

// ---- road insight helpers ----
const sectionedCorridors = () => corridors.listCorridors().filter(isSectioned);
/** Issue the next two hours' forecasts for every road, and score the ones whose time has come. */
function forecastRound() {
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  for (const c of sectionedCorridors()) {
    const n = c.definition.sections.length;
    const rows = travel.rows(c.id, new Date(now - 28 * DAY).toISOString(), new Date(now + 60_000).toISOString());
    const prof = travelProfile(rows, { sections: n });
    const recent = travel.totals(c.id, new Date(now - 4 * 3600_000).toISOString(), new Date(now + 60_000).toISOString()).filter((r) => r.legs === n).map((r) => ({ ts: r.ts, minutes: r.travel_s / 60 }));
    if (recent.length && now - Date.parse(recent[recent.length - 1].ts) < 20 * 60_000) forecasts.issue(c.id, issuedAt, forecastRoad({ profile: prof, recent, nowMs: now }));
    forecasts.score(c.id, recent);
  }
  if (new Date(now).getUTCHours() === 0 && new Date(now).getUTCMinutes() < 15) forecasts.prune(new Date(now - 60 * DAY).toISOString());
}

function roadInsight(c) {
  const now = Date.now();
  const sections = c.definition.sections.length;
  const rows = travel.rows(c.id, new Date(now - 28 * DAY).toISOString(), new Date(now + 60_000).toISOString());
  const prof = travelProfile(rows, { sections });
  const latest = travel.latest(c.id);
  const advice = commuterTips(c, prof);
  const days = daysCovered(rows);
  const road = c.definition?.road;
  const rain = RAIN_POINTS[road] ? weather.series(road, new Date(now - 28 * DAY).toISOString(), new Date(now + 3600_000).toISOString()) : new Map();
  return {
    corridor: c, profile: prof, latest, ...advice, days, confidence: confidenceOf(days.weekdays), source: sourceOf(rows, sections),
    status: liveStatus(c, latest, prof, advice.baseline), since: corridors.db.prepare('SELECT MIN(ts) AS ts FROM route_samples WHERE corridor_id = ?').get(c.id)?.ts,
    forecast: forecasts.latest(c.id), skill: forecasts.skill(c.id, new Date(now - 30 * DAY).toISOString()), rain: rainEffect({ corridor: c, rows, rain }),
  };
}
/** Every change on record, evaluated for each road it touched (cached ten minutes: the placebo check is the costly part). */
let impactCache = { at: 0, list: [] };
function impactResults() {
  if (Date.now() - impactCache.at < 10 * 60_000) return impactCache.list;
  const all = sectionedCorridors();
  const list = interventions.list().map((i) => ({
    id: i.id, title: i.title, start: i.start_ts, end: i.end_ts, source: i.source,
    results: i.corridors.map((id) => all.find((c) => c.id === id)).filter(Boolean).map((c) => ({ corridor: c.id, result: evaluateChange({ travel, treated: c, controls: controlsFor(c, all), start: i.start_ts, end: i.end_ts, hours: i.hours }) })),
  }));
  impactCache = { at: Date.now(), list };
  return list;
}
const corridorNames = () => Object.fromEntries(corridors.listCorridors().map((c) => [c.id, c.name]));
const parseHoursParam = (text) => {
  const m = /^(\d{1,2}):?(\d{2})?\s*-\s*(\d{1,2}):?(\d{2})?$/.exec(String(text || '').trim());
  return m ? [Number(m[1]) * 60 + Number(m[2] || 0), Number(m[3]) * 60 + Number(m[4] || 0)] : null;
};

/** Every sectioned road's insight, in the built-in order, with cross-road notes attached. */
function allInsights() {
  const order = corridorDefinitions().map((d) => d.id);
  const list = sectionedCorridors().sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99)).map(roadInsight);
  const notes = crossRoadNotes(list);
  const agreement = new Map(crosschecks.summary(new Date(Date.now() - 30 * DAY).toISOString()).map((x) => [x.corridor_id, x]));
  const truth = new Map(drives.summary().map((x) => [x.corridor_id, x]));
  const impacts = impactResults();
  for (const r of list) {
    r.truth = truth.get(r.corridor.id) || null;
    r.impacts = impacts.flatMap((e) => e.results.filter((x) => x.corridor === r.corridor.id).map((x) => ({ title: e.title, result: x.result })));
    r.notes = notes.get(r.corridor.id) || [];
    r.agreement = agreement.get(r.corridor.id) || null;
    r.formal = formalReadiness(r.confidence, r.agreement);
  }
  return list;
}
let summaryCache = { at: 0, html: '' };
function summaryHtml() {
  if (Date.now() - summaryCache.at < 60_000 && summaryCache.html) return summaryCache.html;
  const roads = allInsights();
  const since30 = new Date(Date.now() - 30 * DAY).toISOString();
  const last30 = incidents.since(since30);
  const week = weekBounds(lastCompletedWeek(Date.now() + 7 * DAY).key); // the current week
  const html = renderSummary({
    roads,
    events: service.rawEvents(),
    incidentsNow: incidents.current(),
    recurring: recurringJams(last30, { limit: 10 }),
    safety: safetySpots(last30, { limit: 10 }),
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
  const rainFor = (c) => (RAIN_POINTS[c.definition?.road] ? weather.series(c.definition.road, new Date(Date.parse(week.start) - 28 * DAY).toISOString(), week.end) : null);
  const summaries = addCrossRoadNotes(list.map((corridor) => summarizeWeek({ travel, corridor, week, rain: rainFor(corridor) })));
  const agreement = new Map(crosschecks.summary(week.start).map((r) => [r.corridor_id, r]));
  const agreement30 = new Map(crosschecks.summary(new Date(Date.parse(week.end) - 30 * DAY).toISOString()).map((r) => [r.corridor_id, r]));
  const insightById = new Map(allInsights().map((r) => [r.corridor.id, r]));
  for (const s of summaries) {
    const ins = insightById.get(s.corridor.id);
    s.skill = ins?.skill || null;
    s.rainEffect = ins?.rain || null;
    s.impacts = ins?.impacts || [];
    s.agreement = agreement.get(s.corridor.id) || null;
    s.formal = formalReadiness(s.confidence, agreement30.get(s.corridor.id) || null);
  }
  const city = summarizeCity({ incidents, week });
  const notes = [...new Map(list.flatMap((c) => corridors.listNotes(c.id)).filter((n) => n.at >= week.start && n.at < week.end).sort((a, b) => a.at.localeCompare(b.at)).map((n) => [n.text, n])).values()];
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

/**
 * When the mail settings are new (or changed), prove them once without
 * anyone running a command: send this week's report so far as a setup
 * email. The result shows on /health; a failure is not retried until the
 * settings change again.
 */
async function mailSelfTest() {
  if (!mailConfigured()) return;
  const state = mailState();
  const hash = mailConfigHash();
  if (state.verifiedHash === hash || state.verifyFailedHash === hash) return;
  const week = weekBounds(lastCompletedWeek(Date.now() + 7 * DAY).key);
  const { summaries, city, notes } = weeklyReport(week);
  const at = new Date().toISOString();
  try {
    const { accepted } = await sendMail({ ...SMTP, to: REPORT_TO, subject: `Chennai roads · email set up (this week so far, ${week.key})`,
      html: renderWeeklyHtml({ summaries, city, notes, week, baseUrl: REPORT_BASE_URL }), text: renderWeeklyText({ summaries, city, week, baseUrl: REPORT_BASE_URL }) });
    weeklyStore.write('state', { ...mailState(), verifiedHash: hash, verifiedAt: at, verifyError: null, verifyFailedHash: null });
    console.log(`[weekly] mail set up: test email accepted for ${accepted.join(', ')}`);
  } catch (error) {
    weeklyStore.write('state', { ...mailState(), verifyFailedHash: hash, verifyError: error.message, verifyAttemptAt: at });
    console.error(`[weekly] mail set-up test failed: ${error.message}`);
  }
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
    setupTest: !mailConfigured() ? 'not configured' : s.verifiedHash === mailConfigHash() ? `passed ${s.verifiedAt}` : s.verifyFailedHash === mailConfigHash() ? `failed: ${s.verifyError}` : 'pending',
    user: SMTP.user,
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
async function readJson(req, limit = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('body too large');
  }
  return body ? JSON.parse(body) : {};
}
// With ADMIN_TOKEN set, the public pages and reads of recorded data stay
// open (they are meant to be shared and cost no quota); everything that
// registers, deletes, samples, polls or sends needs the token.
// /mail/check and /weekly/send are admin-only (not in PUBLIC_READ).
const PUBLIC_READ = /^\/(|summary|methodology|impact|impact\.json|impact\/evaluate|forecast|rain-effect|brief(\/[a-z0-9-]+)?|drive|drives|roads\/geo|roads\/history|health|incidents|weekly(\/\d{4}-W\d{2}(\.json)?)?|corridors(\/[a-z0-9-]+(\/(report|latest|series|compare|travel|tips))?)?)$/;
const authorized = (req) =>
  !ADMIN_TOKEN ||
  req.headers.authorization === `Bearer ${ADMIN_TOKEN}` ||
  (req.method === 'GET' && PUBLIC_READ.test(new URL(req.url, 'http://localhost').pathname));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health')
      return json(res, 200, { ...service.health(), corridors: { every_minutes: CORRIDOR_MINUTES, count: sectionedCorridors().length, last: status.corridors }, incidents: { every_minutes: INCIDENT_MINUTES, last: status.incidents }, rain: status.rain, rollup: status.rollup, crosscheck: { configured: Boolean(GOOGLE_ROUTES_KEY), hours: [...GOOGLE_CHECK_HOURS].join(','), cap: GOOGLE_MONTHLY_CAP, last: status.crosscheck }, retentionDays: RAW_RETENTION_DAYS, mail: mailHealth() });
    // ---- timed drives (their own key: the map password) ----
    if (req.method === 'GET' && url.pathname === '/drive') return html(res, renderDriveApp(), 'no-store');
    if (req.method === 'GET' && url.pathname === '/drives') {
      const list = drives.list(50).map(({ note, ...d }) => d);
      return json(res, 200, { summary: drives.summary(), drives: list });
    }
    if (url.pathname === '/drives/check' || url.pathname === '/drives/start' || /^\/drives\/[a-z0-9]+\/(finish|track)$/.test(url.pathname)) {
      if (!DRIVE_KEYS.length) return json(res, 403, { error: 'drive logging is not configured on this server' });
      const gate = driveThrottled(req);
      if (gate.blocked) return json(res, 429, { error: 'too many attempts; try again in fifteen minutes' });
      if (!driveKeyOk(req)) return gate.fail(), json(res, 401, { error: 'wrong password' });
      if (req.method === 'GET' && url.pathname === '/drives/check') return json(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/drives/start') {
        const body = await readJson(req);
        const c = corridors.getCorridor(String(body.corridorId || ''));
        if (!isSectioned(c)) return json(res, 400, { error: 'unknown road' });
        const id = randomBytes(8).toString('hex');
        const startedAt = new Date().toISOString();
        let tomtom = null;
        try {
          const s = await sampleSections(c, { key: TOMTOM_KEY });
          tomtom = { ts: s.ts, predS: s.rows.reduce((a, r) => a + (r.travelS || 0), 0), typicalS: s.rows.reduce((a, r) => a + (r.historicS || 0), 0), legs: s.rows.map((r) => r.travelS) };
        } catch (error) {
          console.error('[drive] TomTom prediction failed:', error.message);
        }
        if (GOOGLE_ROUTES_KEY && crosschecks.callsInMonth(istMonth()) < GOOGLE_MONTHLY_CAP) {
          try {
            const g = await googleDrive(c, { key: GOOGLE_ROUTES_KEY });
            pendingGoogle.set(id, { seconds: g.seconds, at: Date.now() });
            crosschecks.record(c.id, startedAt, null, { outcome: 'drive' }); // counts towards the monthly cap; holds no Google data
          } catch (error) {
            console.error('[drive] Google prediction failed:', error.message);
          }
        }
        for (const [k, v] of pendingGoogle) if (Date.now() - v.at > 6 * 3_600_000) pendingGoogle.delete(k);
        drives.start({ id, corridorId: c.id, startedAt, tomtom });
        console.log(`[drive] started ${id} on ${c.id}`);
        return json(res, 200, { id, prediction: tomtom && { tomtomMinutes: tomtom.predS / 60, typicalMinutes: tomtom.typicalS / 60 } });
      }
      const dm = url.pathname.match(/^\/drives\/([a-z0-9]+)\/(finish|track)$/);
      const d = drives.get(dm[1]);
      if (!d) return json(res, 404, { error: 'drive not found' });
      if (req.method === 'GET' && dm[2] === 'track') return json(res, 200, { id: d.id, corridor: d.corridor_id, note: d.note, track: d.track ? JSON.parse(d.track) : [] });
      if (req.method === 'POST' && dm[2] === 'finish') {
        if (d.status !== 'started') return json(res, 409, { error: `drive already ${d.status}` });
        const body = await readJson(req, 3 * 1024 * 1024);
        const c = corridors.getCorridor(d.corridor_id);
        if (body.cancelled) {
          pendingGoogle.delete(d.id);
          drives.finish(d.id, { cancelled: true });
          return json(res, 200, { cancelled: true });
        }
        const track = cleanTrack(body.track);
        const analysis = analyzeDrive({ corridor: c, track });
        const g = pendingGoogle.get(d.id);
        pendingGoogle.delete(d.id);
        const googleBand = g && analysis.valid ? errorOf(g.seconds, analysis.actualS)?.band ?? null : null;
        const saved = drives.finish(d.id, { analysis, track, note: body.note, googleBand });
        const { track: _t, note: _n, ...publicDrive } = saved;
        console.log(`[drive] ${d.id} ${saved.status}${analysis.valid ? ` · ${Math.round(analysis.actualS / 60)} min vs TomTom ${Math.round((d.tomtom_pred_s || 0) / 60)}` : ` · ${analysis.problems.join('; ')}`}`);
        return json(res, 200, { drive: publicDrive, analysis, sections: c.definition.sections, predictionLegs: d.tomtom_pred_legs ? JSON.parse(d.tomtom_pred_legs) : [] });
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/summary')) return html(res, summaryHtml(), 'public, max-age=60');
    if (req.method === 'GET' && url.pathname === '/incidents') {
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 30));
      const recent = incidents.since(new Date(Date.now() - days * DAY).toISOString());
      return json(res, 200, { current: incidents.current(), recurringJams: recurringJams(recent, { limit: 25 }), safetySpots: safetySpots(recent, { limit: 25 }), since: incidents.firstSeen(), last: status.incidents });
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

    if (req.method === 'GET' && url.pathname === '/methodology') {
      const roads = allInsights();
      return html(res, renderMethodology({
        roads,
        incidentCounts: incidents.counts('2000-01-01T00:00:00.000Z'),
        incidentsSince: incidents.firstSeen(),
        rainSince: corridors.db.prepare('SELECT MIN(hour) AS h FROM rain_hourly').get()?.h || null,
        retentionDays: RAW_RETENTION_DAYS,
        exportPublic: EXPORT_PUBLIC,
        crosscheck: { configured: Boolean(GOOGLE_ROUTES_KEY), hours: GOOGLE_CHECK_HOURS, cap: GOOGLE_MONTHLY_CAP, rows: crosschecks.summary(new Date(Date.now() - 30 * DAY).toISOString()) },
        groundTruth: drives.summary(),
        notes: corridors.db.prepare('SELECT * FROM notes ORDER BY at').all().filter((n, i, all) => all.findIndex((x) => x.text === n.text) === i),
      }), 'public, max-age=300');
    }
    if (req.method === 'GET' && url.pathname === '/export/slots.csv') {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : '2000-01-01';
      const to = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') || '') ? url.searchParams.get('to') : '2999-12-31';
      const byId = new Map(corridors.listCorridors().map((c) => [c.id, c]));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="chennai-roads-slots-${from}-${to}.csv"`, 'Cache-Control': 'no-store' });
      return res.end(rollupCsv(rollups.rows(from, to, url.searchParams.get('corridor') || null), byId));
    }
    if (req.method === 'POST' && url.pathname === '/rollup') return json(res, 200, rollUp());
    if (req.method === 'POST' && url.pathname === '/interventions') {
      const b = await readJson(req);
      if (!b?.id || !b.title || !Array.isArray(b.corridors) || !b.start) return json(res, 400, { error: 'id, title, corridors [ids] and start are required' });
      interventions.upsert({ id: String(b.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80), title: b.title, corridors: b.corridors, start: new Date(b.start).toISOString(), end: b.end ? new Date(b.end).toISOString() : null, hours: b.hours ? parseHoursParam(b.hours) : null, source: b.source || null });
      impactCache.at = 0;
      return json(res, 200, { interventions: interventions.list() });
    }
    if (req.method === 'POST' && url.pathname === '/crosscheck') return json(res, 200, (await crossCheckIfDue({ force: true })) || { skipped: 'GOOGLE_ROUTES_API_KEY not set' });
    // ---- mail check: log in to the mail server and stop, no email sent ----
    if (req.method === 'POST' && url.pathname === '/mail/check') {
      const settings = mailSettingsReport();
      try {
        await sendMail({ ...SMTP, to: REPORT_TO.length ? REPORT_TO : [SMTP.user], subject: 'check', html: '<p/>', loginOnly: true });
        return json(res, 200, { ok: true, login: 'accepted', settings });
      } catch (error) {
        return json(res, 200, { ok: false, error: error.message, settings });
      }
    }
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

    // ---- measuring changes, forecasts, rain, briefs (public, recorded data only) ----
    if (req.method === 'GET' && url.pathname === '/impact') {
      return html(res, renderImpactPage({ evaluations: impactResults(), corridors: sectionedCorridors(), names: corridorNames() }), 'public, max-age=120');
    }
    if (req.method === 'GET' && url.pathname === '/impact.json') return json(res, 200, { evaluations: impactResults() });
    if (req.method === 'GET' && url.pathname === '/impact/evaluate') {
      const c = corridors.getCorridor(String(url.searchParams.get('corridor') || ''));
      const start = url.searchParams.get('start'), end = url.searchParams.get('end') || null;
      if (!isSectioned(c)) return json(res, 400, { error: 'Choose one of the monitored roads.' });
      if (!start || Number.isNaN(Date.parse(start)) || (end && Number.isNaN(Date.parse(end)))) return json(res, 400, { error: 'Give the start (and end, if any) as dates.' });
      const hours = url.searchParams.get('hours') ? parseHoursParam(url.searchParams.get('hours')) : null;
      if (url.searchParams.get('hours') && !hours) return json(res, 400, { error: 'Hours look like 16:00-21:00.' });
      const result = evaluateChange({ travel, treated: c, controls: controlsFor(c, sectionedCorridors()), start: new Date(start).toISOString(), end: end && new Date(end).toISOString(), hours });
      return json(res, 200, { result, text: impactText(result, corridorNames()) });
    }
    if (req.method === 'GET' && url.pathname === '/forecast') {
      return json(res, 200, { roads: allInsights().map((r) => ({ id: r.corridor.id, name: r.corridor.name, forecast: r.forecast, skill: r.skill })) });
    }
    if (req.method === 'GET' && url.pathname === '/rain-effect') return json(res, 200, { roads: allInsights().map((r) => r.rain) });
    const bm = url.pathname.match(/^\/brief(?:\/([a-z0-9-]+))?$/);
    if (req.method === 'GET' && bm) {
      const list = allInsights();
      const generatedAt = new Date().toISOString();
      const pick = !bm[1] || bm[1] === 'all' ? list : list.filter((r) => r.corridor.id === bm[1]);
      if (!pick.length) return json(res, 404, { error: 'road not found' });
      const sections = pick.map((r) => briefSection({ insight: r, totals: travel.totals(r.corridor.id, new Date(Date.now() - 7 * DAY).toISOString(), new Date(Date.now() + 60_000).toISOString()), forecast: r.forecast, skill: r.skill, rain: r.rain, impacts: r.impacts, names: corridorNames(), generatedAt }));
      const index = !bm[1] ? `<div class="index"><b>Briefs</b>: ${list.map((r) => `<a href="/brief/${r.corridor.id}">${r.corridor.name.split('·')[0].trim()}</a>`).join(' · ')}</div>` : null;
      return html(res, renderBriefs({ sections, title: pick.length === 1 ? `Brief · ${pick[0].corridor.name}` : 'Chennai roads · briefs', index }), 'no-store');
    }

    // ---- map feeds (recorded data only; CORS-open for map clients) ----
    if (req.method === 'GET' && (url.pathname === '/roads/geo' || url.pathname === '/roads/history')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (url.pathname === '/roads/geo') {
        const body = buildGeoFeed({ insights: allInsights(), incidentsNow: incidents.current() });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
        return res.end(JSON.stringify(body));
      }
      const hours = Math.max(1, Math.min(24 * 7, Number(url.searchParams.get('hours')) || 24));
      const toIso = new Date(Date.now() + 60_000).toISOString();
      const fromIso = new Date(Date.now() - hours * 3600_000).toISOString();
      const body = buildHistory({ roads: allInsights().map((r) => ({ corridor: r.corridor, baseline: r.baseline })), travel, fromIso, toIso });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
      return res.end(JSON.stringify(body));
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
        const r = allInsights().find((x) => x.corridor.id === corridor.id) || roadInsight(corridor);
        return json(res, 200, { corridor: corridor.id, status: r.status, tips: r.tips, notes: r.notes || [], rushes: r.rushes, baseline: r.baseline, source: r.source, confidence: r.confidence, days: r.days, enoughData: r.enoughData, daysRecorded: r.daysRecorded, weekday: r.profile.weekday, weekend: r.profile.weekend });
      }
      // Legacy point-speed series (recorded 24–29 Sep 2026 before section sampling).
      if (sub === 'series') return json(res, 200, { corridor: corridor.id, from, to, series: corridors.series(corridor.id, from, to) });
      const a = parseWindow(url.searchParams.get('a')), b = parseWindow(url.searchParams.get('b'));
      const comparison = a && b ? compareProfiles(profile(corridors.series(corridor.id, a.from, a.to)), profile(corridors.series(corridor.id, b.from, b.to))) : null;
      if (sub === 'compare') return json(res, 200, { corridor: corridor.id, a, b, comparison });
      if (sub === 'report' || !sub) {
        const insight = isSectioned(corridor) ? allInsights().find((x) => x.corridor.id === corridor.id) || roadInsight(corridor) : null;
        const road = corridor.definition?.road;
        return html(res, renderReport({
          corridor,
          series: corridors.series(corridor.id, from, to),
          latest: corridors.latest(corridor.id),
          notes: corridors.listNotes(corridor.id),
          comparison,
          windows: { hours, a: a?.label, b: b?.label },
          travel: insight && { totals: travel.totals(corridor.id, from, to), latest: insight.latest, status: insight.status, tips: insight.tips, notes: insight.notes, agreement: insight.agreement, formal: insight.formal, googleConfigured: Boolean(GOOGLE_ROUTES_KEY), forecast: insight.forecast, skill: insight.skill, rain: insight.rain, impacts: insight.impacts, truth: insight.truth, profile: insight.profile, baseline: insight.baseline, source: insight.source, confidence: insight.confidence, jams: travel.jams(corridor.id, from, to), rain: RAIN_POINTS[road] ? weather.series(road, from, to) : null },
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
  if (RAIN_MINUTES > 0) {
    pollRain();
    setInterval(pollRain, RAIN_MINUTES * 60_000).unref();
  }
  // Roll up finished days shortly after start and then hourly (cheap: only missing days and yesterday).
  setTimeout(() => { try { console.log('[rollup]', JSON.stringify(rollUp())); } catch (e) { console.error('[rollup] failed:', e.message); } }, 120_000).unref();
  setInterval(() => { try { rollUp(); } catch (e) { console.error('[rollup] failed:', e.message); } }, 60 * 60_000).unref();
  const mail = mailHealth();
  console.log(`[weekly] report at /weekly · ${mail.configured ? `emailed to ${REPORT_TO.length} recipient(s) via ${SMTP.host}:${SMTP.port}, ${mail.schedule}${mail.waitingForNewSettings ? ` · PAUSED after: ${mail.lastError}` : ''}` : 'email off (set SMTP_USER, SMTP_PASS, REPORT_TO)'}`);
  setInterval(weeklyTick, 60_000).unref();
  setTimeout(() => mailSelfTest().catch((e) => console.error('[weekly] self-test:', e.message)), 90_000).unref();
});
