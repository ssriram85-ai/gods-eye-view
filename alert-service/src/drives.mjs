/**
 * Ground truth: timed drives along a monitored road, recorded by a phone's
 * GPS, compared with what TomTom (and Google) predicted at the moment the
 * drive began. This is the one source that is ours: no provider terms
 * limit it, and it answers the question a panel asks first, "how do you
 * know these times are right?".
 *
 * A drive's GPS track is private (it is a person's location); only the
 * comparison results are published.
 */
import { haversineKm, distanceToLineKm } from './geo.mjs';

/** How close the track must come to a junction to count as passing it, and to the road to count as on it. */
export const PASS_KM = 0.15;
export const ON_ROAD_KM = 0.2;
export const MIN_ON_ROAD_SHARE = 0.9;

/**
 * Find when the track passed each junction: the moment of closest approach,
 * searched in order (each after the previous), interpolated between fixes.
 * Returns ms timestamps or null for a junction never passed within PASS_KM.
 */
export function passTimes(track, waypoints) {
  const out = [];
  let from = 0;
  for (const w of waypoints) {
    let best = -1, bestKm = Infinity;
    for (let i = from; i < track.length; i++) {
      const d = haversineKm(w.lat, w.lon, track[i].lat, track[i].lon);
      if (d < bestKm) (bestKm = d), (best = i);
      // Once we are well past a close approach, stop: the next junction starts here.
      if (bestKm <= PASS_KM && d > bestKm + 0.5) break;
    }
    if (best < 0 || bestKm > PASS_KM) {
      out.push(null);
      continue;
    }
    // Refine between the neighbouring fixes: project the junction onto each segment around the closest fix.
    let t = track[best].t;
    for (const j of [best - 1, best]) {
      const a = track[j], b = track[j + 1];
      if (!a || !b) continue;
      const kx = Math.cos((w.lat * Math.PI) / 180) * 111.32, ky = 110.574;
      const ax = (a.lon - w.lon) * kx, ay = (a.lat - w.lat) * ky, bx = (b.lon - w.lon) * kx, by = (b.lat - w.lat) * ky;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      if (!len2) continue;
      const f = -(ax * dx + ay * dy) / len2;
      if (f >= 0 && f <= 1) {
        t = a.t + f * (b.t - a.t);
        break;
      }
    }
    out.push(Math.round(t));
    from = best;
  }
  return out;
}

/** Clean a submitted track: numbers only, time-ordered, plausible accuracy and coordinates. */
export function cleanTrack(raw, { maxPoints = 6000 } = {}) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => ({ t: Number(p.t), lat: Number(p.lat), lon: Number(p.lon), acc: p.acc == null ? null : Number(p.acc) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && (p.acc == null || p.acc <= 100))
    .sort((a, b) => a.t - b.t)
    .slice(0, maxPoints);
}

/**
 * Analyse a drive against its corridor. A drive is valid only if it passed
 * every junction in order and stayed on the road for at least 90% of fixes.
 */
export function analyzeDrive({ corridor, track }) {
  const waypoints = corridor.points || [];
  const sections = corridor.definition?.sections || [];
  const line = corridor.definition?.line || waypoints.map((p) => [p.lon, p.lat]);
  const problems = [];
  if (track.length < 10) problems.push('fewer than ten GPS fixes');
  const times = track.length ? passTimes(track, waypoints) : waypoints.map(() => null);
  const missed = times.map((t, i) => (t == null ? waypoints[i].name || `junction ${i + 1}` : null)).filter(Boolean);
  if (missed.length) problems.push(`did not pass ${missed.join(', ')} within ${PASS_KM * 1000} m`);
  // On-road share between the first and last junction passed.
  const first = times.find((t) => t != null), last = [...times].reverse().find((t) => t != null);
  const inside = track.filter((p) => first != null && p.t >= first && p.t <= last);
  const onRoad = inside.length ? inside.filter((p) => distanceToLineKm(p.lon, p.lat, line) <= ON_ROAD_KM).length / inside.length : 0;
  if (inside.length && onRoad < MIN_ON_ROAD_SHARE) problems.push(`only ${Math.round(onRoad * 100)}% of the drive was on the road (needs ${Math.round(MIN_ON_ROAD_SHARE * 100)}%)`);
  const legs = sections.map((_, i) => (times[i] != null && times[i + 1] != null && times[i + 1] > times[i] ? (times[i + 1] - times[i]) / 1000 : null));
  const actualS = times[0] != null && times[times.length - 1] != null ? (times[times.length - 1] - times[0]) / 1000 : null;
  // Large gaps between fixes (screen off, tunnel) make stretch times guesses.
  const gaps = inside.slice(1).map((p, i) => p.t - inside[i].t);
  const maxGapS = gaps.length ? Math.max(...gaps) / 1000 : null;
  if (maxGapS != null && maxGapS > 120) problems.push(`the GPS went quiet for ${Math.round(maxGapS / 60)} min (keep the screen on)`);
  return {
    valid: problems.length === 0 && actualS != null,
    problems,
    actualS,
    legs,
    passTimes: times.map((t) => (t == null ? null : new Date(t).toISOString())),
    departedAt: times[0] == null ? null : new Date(times[0]).toISOString(),
    onRoadShare: onRoad,
    points: track.length,
    maxGapS,
  };
}

/** How a prediction compares with the drive: signed error and a band. */
export function errorOf(predictedS, actualS) {
  if (!(predictedS > 0) || !(actualS > 0)) return null;
  const err = (predictedS - actualS) / actualS;
  return { pct: err, band: Math.abs(err) <= 0.1 ? 'within10' : Math.abs(err) <= 0.2 ? 'within20' : err > 0 ? 'over' : 'under' };
}

export function createDriveStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drives (
      id TEXT PRIMARY KEY, corridor_id TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, departed_at TEXT,
      tomtom_ts TEXT, tomtom_pred_s REAL, tomtom_pred_legs TEXT, tomtom_typical_s REAL,
      google_band TEXT, actual_s REAL, actual_legs TEXT, tomtom_error_pct REAL, tomtom_band TEXT,
      on_road_share REAL, points INTEGER, problems TEXT, note TEXT, track TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_drives_corridor ON drives (corridor_id, started_at);
  `);
  return {
    start({ id, corridorId, startedAt, tomtom }) {
      db.prepare(`INSERT INTO drives (id, corridor_id, status, started_at, tomtom_ts, tomtom_pred_s, tomtom_pred_legs, tomtom_typical_s)
        VALUES (?, ?, 'started', ?, ?, ?, ?, ?)`).run(id, corridorId, startedAt, tomtom?.ts ?? null, tomtom?.predS ?? null, tomtom ? JSON.stringify(tomtom.legs) : null, tomtom?.typicalS ?? null);
      return this.get(id);
    },
    get: (id) => db.prepare('SELECT * FROM drives WHERE id = ?').get(id) || null,
    finish(id, { analysis, track, note, googleBand, cancelled = false }) {
      const d = this.get(id);
      if (!d) return null;
      const err = analysis?.valid ? errorOf(d.tomtom_pred_s, analysis.actualS) : null;
      db.prepare(`UPDATE drives SET status = ?, finished_at = ?, departed_at = ?, actual_s = ?, actual_legs = ?, tomtom_error_pct = ?, tomtom_band = ?,
          google_band = ?, on_road_share = ?, points = ?, problems = ?, note = ?, track = ? WHERE id = ?`).run(
        cancelled ? 'cancelled' : analysis?.valid ? 'valid' : 'invalid',
        new Date().toISOString(),
        analysis?.departedAt ?? null,
        analysis?.actualS ?? null,
        analysis ? JSON.stringify(analysis.legs) : null,
        err?.pct ?? null,
        err?.band ?? null,
        analysis?.valid ? googleBand ?? null : null,
        analysis?.onRoadShare ?? null,
        analysis?.points ?? 0,
        analysis ? JSON.stringify(analysis.problems) : null,
        note ? String(note).slice(0, 500) : null,
        track ? JSON.stringify(track) : null,
        id,
      );
      return this.get(id);
    },
    /** Finished drives, newest first, without tracks. */
    list: (limit = 100) =>
      db.prepare(`SELECT id, corridor_id, status, started_at, finished_at, departed_at, tomtom_pred_s, tomtom_typical_s, actual_s, actual_legs, tomtom_pred_legs,
          tomtom_error_pct, tomtom_band, google_band, on_road_share, points, problems, note FROM drives WHERE status != 'started' ORDER BY started_at DESC LIMIT ?`).all(limit),
    /** Per corridor: valid drives, typical size of TomTom's error, bands for both sources. */
    summary() {
      const rows = db.prepare("SELECT corridor_id, tomtom_error_pct, tomtom_band, google_band FROM drives WHERE status = 'valid'").all();
      const by = new Map();
      for (const r of rows) {
        const s = by.get(r.corridor_id) || { corridor_id: r.corridor_id, drives: 0, absErrors: [], tomtomWithin10: 0, tomtomWithin20: 0, google: 0, googleWithin10: 0, googleWithin20: 0 };
        s.drives++;
        if (r.tomtom_error_pct != null) s.absErrors.push(Math.abs(r.tomtom_error_pct));
        if (r.tomtom_band === 'within10') s.tomtomWithin10++;
        if (r.tomtom_band === 'within10' || r.tomtom_band === 'within20') s.tomtomWithin20++;
        if (r.google_band) {
          s.google++;
          if (r.google_band === 'within10') s.googleWithin10++;
          if (r.google_band === 'within10' || r.google_band === 'within20') s.googleWithin20++;
        }
        by.set(r.corridor_id, s);
      }
      return [...by.values()].map((s) => {
        const sorted = s.absErrors.sort((a, b) => a - b);
        return { ...s, medianAbsError: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, absErrors: undefined };
      });
    },
  };
}

/** Plain-language result for one corridor's ground-truth summary. */
export function groundTruthText(s) {
  if (!s?.drives) return 'no timed drives yet';
  const pct = (a, b) => `${Math.round((a / b) * 100)}%`;
  const parts = [`${s.drives} timed drive${s.drives === 1 ? '' : 's'}: TomTom's prediction at departure was within 10% of the real drive in ${pct(s.tomtomWithin10, s.drives)} and within 20% in ${pct(s.tomtomWithin20, s.drives)}${s.medianAbsError != null ? ` (typical error ${Math.round(s.medianAbsError * 100)}%)` : ''}`];
  if (s.google) parts.push(`Google's was within 10% in ${pct(s.googleWithin10, s.google)} of ${s.google}`);
  return parts.join('; ');
}
