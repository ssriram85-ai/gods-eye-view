/**
 * Feeds for maps: each monitored road split into its stretches with the
 * stretch's polyline, its night-time drive and its live state, plus a
 * history of stretch states for replaying how a rush builds. Built from
 * recorded data only; serving them spends no API quota.
 */
import { haversineKm } from './geo.mjs';
import { istSlot, dayType } from './insights.mjs';

/** Traffic level from a drive time over its night-time drive (same bands as the public page). */
export const levelOf = (ratio) => (ratio == null ? 'unknown' : ratio < 1.15 ? 'clear' : ratio < 1.4 ? 'busy' : ratio < 1.75 ? 'heavy' : 'jammed');

/** Split a road polyline ([lon, lat] points) at its junctions, in order. */
export function splitAtJunctions(line, junctions) {
  if (!Array.isArray(line) || line.length < 2 || junctions.length < 2) return [];
  const idx = [];
  let from = 0;
  for (const j of junctions) {
    let best = from, bestKm = Infinity;
    for (let i = from; i < line.length; i++) {
      const d = haversineKm(j.lat, j.lon, line[i][1], line[i][0]);
      if (d < bestKm) (bestKm = d), (best = i);
    }
    idx.push(best);
    from = best;
  }
  idx[0] = 0;
  idx[idx.length - 1] = line.length - 1;
  const out = [];
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = Math.max(idx[k + 1], a + 1);
    const seg = line.slice(a, b + 1);
    // Start and end exactly on the junctions so neighbouring stretches meet.
    seg[0] = [Number(junctions[k].lon), Number(junctions[k].lat)];
    seg[seg.length - 1] = [Number(junctions[k + 1].lon), Number(junctions[k + 1].lat)];
    out.push(seg);
  }
  return out;
}

const round = (x, d = 1) => (x == null ? null : Number(x.toFixed(d)));

/**
 * The live map feed. `insights` are the server's road insights (corridor,
 * latest, baseline, status, source, confidence, formal, agreement).
 */
export function buildGeoFeed({ insights, incidentsNow = [], generatedAt = new Date().toISOString() }) {
  return {
    generatedAt,
    attribution: 'Traffic data © TomTom; checked against Google Maps Platform',
    corridors: insights.map((r) => {
      const c = r.corridor;
      const sections = c.definition?.sections || [];
      const lines = splitAtJunctions(c.definition?.line, c.points || []);
      const rows = r.latest?.rows || [];
      const night = r.baseline?.sectionMinutes || [];
      return {
        id: c.id,
        name: c.name,
        road: c.definition?.road || null,
        direction: c.definition?.direction || null,
        lengthKm: c.lengthKm,
        source: r.source?.kind || 'unknown',
        confidence: r.confidence?.level || 'early',
        formalUse: Boolean(r.formal?.ready),
        now: r.status
          ? { ts: r.status.ts, minutes: round(r.status.minutes), nightMinutes: round(r.status.nightMinutes), typicalMinutes: round(r.status.usualMinutes), level: r.status.level, unusual: Boolean(r.status.unusual) }
          : null,
        stretches: sections.map((s, i) => {
          const row = rows.find((x) => x.leg === i);
          const minutes = row?.travel_s != null ? row.travel_s / 60 : null;
          const base = night[i] ?? (row?.no_traffic_s != null ? row.no_traffic_s / 60 : null);
          const ratio = minutes != null && base ? minutes / base : null;
          return { index: i, from: s.from, to: s.to, lengthKm: s.lengthKm, line: lines[i] || [], nightMinutes: round(base), minutes: round(minutes), ratio: round(ratio, 2), level: levelOf(ratio) };
        }),
      };
    }),
    incidents: incidentsNow
      .filter((i) => ['accident', 'flooding', 'broken-down vehicle', 'dangerous conditions'].includes(i.category) || (i.category === 'jam' && (i.delay_s || 0) >= 300))
      .slice(0, 60)
      .map((i) => ({ category: i.category, lat: i.lat, lon: i.lon, delayMinutes: i.delay_s ? Math.round(i.delay_s / 60) : null, place: [i.from_name, i.to_name].filter(Boolean).join(' → ') || i.road || null })),
  };
}

/**
 * History for replay: one frame per sample time, with each stretch's
 * ratio to its night-time drive. `roads` = [{ corridor, baseline }].
 */
export function buildHistory({ roads, travel, fromIso, toIso }) {
  const frames = new Map();
  for (const { corridor, baseline } of roads) {
    const n = corridor.definition?.sections?.length || 0;
    const night = baseline?.sectionMinutes || [];
    for (const r of travel.rows(corridor.id, fromIso, toIso)) {
      const f = frames.get(r.ts) || { ts: r.ts, corridors: {} };
      const arr = f.corridors[corridor.id] || (f.corridors[corridor.id] = new Array(n).fill(null));
      const base = night[r.leg] ?? (r.no_traffic_s ? r.no_traffic_s / 60 : null);
      if (r.travel_s != null && base) arr[r.leg] = round(r.travel_s / 60 / base, 2);
      frames.set(r.ts, f);
    }
  }
  const list = [...frames.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  return { from: fromIso, to: toIso, frames: list.map((f) => ({ ...f, slot: istSlot(f.ts), dayType: dayType(f.ts) })) };
}
