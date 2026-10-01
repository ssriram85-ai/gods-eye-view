/**
 * The monsoon effect: how many extra minutes each stretch loses when it
 * rains, by rain intensity. For every reading with a known rainfall that
 * hour, the stretch's drive is compared with its typical drive on dry days
 * at the same half-hour (weekdays and weekends kept apart). The median
 * excess per rain band is reported only when it rests on enough readings
 * across enough days; otherwise the page says the rain has not come yet.
 */
import { samplesOf, istSlot, dayType, dayKey, quantile } from './insights.mjs';
import { rainAt, rainBand } from './weather.mjs';

export const BANDS = Object.freeze(['drizzle', 'light', 'moderate', 'heavy']);
export const MIN = Object.freeze({ readings: 6, days: 2 });

const med = (xs) => quantile([...xs].sort((a, b) => a - b), 0.5);

/**
 * rows: route_samples rows for a corridor; rain: Map(hour ISO → mm) for its
 * road. Returns per-stretch and whole-road median excess minutes per band.
 */
export function rainEffect({ corridor, rows, rain }) {
  const sections = corridor.definition?.sections || [];
  const samples = samplesOf(rows, sections.length);
  const key = (s) => `${dayType(s.ts)}:${istSlot(s.ts)}`;
  // Typical dry drive per slot, per stretch and whole road.
  const dry = new Map();
  for (const s of samples) {
    const mm = rainAt(rain, s.ts);
    if (mm == null || mm > 0.2) continue;
    const d = dry.get(key(s)) || { total: [], legs: sections.map(() => []) };
    d.total.push(s.travel / 60);
    s.legs.forEach((v, i) => v != null && d.legs[i].push(v / 60));
    dry.set(key(s), d);
  }
  const bands = Object.fromEntries(BANDS.map((b) => [b, { total: [], legs: sections.map(() => []), days: new Set() }]));
  for (const s of samples) {
    const band = rainBand(rainAt(rain, s.ts));
    if (!band || band === 'dry') continue;
    const d = dry.get(key(s));
    if (!d || d.total.length < 2) continue;
    const b = bands[band];
    b.total.push(s.travel / 60 - med(d.total));
    s.legs.forEach((v, i) => v != null && d.legs[i].length >= 2 && b.legs[i].push(v / 60 - med(d.legs[i])));
    b.days.add(dayKey(s.ts));
  }
  const enough = (b) => b.total.length >= MIN.readings && b.days.size >= MIN.days;
  return {
    corridor: corridor.id,
    bands: BANDS.map((name) => {
      const b = bands[name];
      return {
        band: name,
        readings: b.total.length,
        days: b.days.size,
        enough: enough(b),
        extraMinutes: enough(b) ? med(b.total) : null,
        stretches: enough(b) ? sections.map((s, i) => ({ stretch: `${s.from} → ${s.to}`, extraMinutes: b.legs[i].length >= MIN.readings ? med(b.legs[i]) : null })) : [],
      };
    }),
    wetReadings: BANDS.reduce((a, n) => a + bands[n].total.length, 0),
  };
}

/** Below this, an effect is within ordinary day-to-day variation. */
export const CLEAR_EFFECT_MIN = 1.5;

/** One plain sentence for a road's rain effect. */
export function rainText(e) {
  const known = (e?.bands || []).filter((b) => b.enough);
  if (!known.length) return `not enough rain recorded yet (${e?.wetReadings || 0} wet reading${e?.wetReadings === 1 ? '' : 's'}; each band needs ${MIN.readings} across ${MIN.days} days)`;
  const parts = known.map((b) =>
    Math.abs(b.extraMinutes) < CLEAR_EFFECT_MIN
      ? `${b.band} rain: no clear effect`
      : b.extraMinutes > 0
        ? `${b.band} rain adds about ${Math.round(b.extraMinutes)} min`
        : `${b.band} rain: drives were ${Math.round(-b.extraMinutes)} min quicker than usual, which needs more wet days to explain`,
  );
  const wettest = known[known.length - 1];
  const worst = wettest.stretches.filter((x) => x.extraMinutes != null && x.extraMinutes >= CLEAR_EFFECT_MIN).sort((a, b) => b.extraMinutes - a.extraMinutes)[0];
  return `${parts.join('; ')}${worst ? `; the stretch that suffers most is ${worst.stretch} (+${Math.round(worst.extraMinutes)} min in ${wettest.band} rain)` : ''}`;
}
