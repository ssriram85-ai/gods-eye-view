import { randomUUID } from 'node:crypto';
import { fetchEvents, severityRank } from './feeds.mjs';
import { matchAll } from './match.mjs';
import { createStore } from './store.mjs';
import { deliver } from './deliver.mjs';

const ASSET_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const PRODUCT = /^[a-z0-9-]{1,40}$/;

/** Validate and normalize an asset registration; throws a message the API returns as 400. */
export function normalizeAsset(input) {
  if (!input || typeof input !== 'object') throw new Error('asset must be an object');
  const product = String(input.product || '').toLowerCase();
  const id = String(input.id || '');
  if (!PRODUCT.test(product)) throw new Error('product must be a short slug (e.g. shelflifepro)');
  if (!ASSET_ID.test(id)) throw new Error('id must be 1-80 chars of letters, digits, ., _, :, -');
  const latitude = Number(input.latitude), longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new Error('latitude must be a number within ±90');
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error('longitude must be a number within ±180');
  const radius = input.radius_km == null ? 0 : Number(input.radius_km);
  if (!Number.isFinite(radius) || radius < 0 || radius > 200) throw new Error('radius_km must be 0-200');
  let webhookUrl = null;
  if (input.webhook_url != null && input.webhook_url !== '') {
    const url = new URL(String(input.webhook_url));
    if (!/^https?:$/.test(url.protocol)) throw new Error('webhook_url must be http(s)');
    webhookUrl = url.href;
  }
  const thresholds = {};
  if (input.thresholds && typeof input.thresholds === 'object') {
    if (input.thresholds.min_severity != null) {
      if (severityRank(input.thresholds.min_severity) < 0 || !['info', 'warning', 'critical'].includes(input.thresholds.min_severity))
        throw new Error('thresholds.min_severity must be info, warning or critical');
      thresholds.min_severity = input.thresholds.min_severity;
    }
    if (input.thresholds.heat_feels_like_c != null) {
      const h = Number(input.thresholds.heat_feels_like_c);
      if (!Number.isFinite(h) || h < 25 || h > 60) throw new Error('thresholds.heat_feels_like_c must be 25-60');
      thresholds.heat_feels_like_c = h;
    }
  }
  return {
    key: `${product}:${id}`,
    product,
    id,
    tenant_id: input.tenant_id == null ? null : String(input.tenant_id).slice(0, 40),
    name: String(input.name || id).slice(0, 120),
    latitude,
    longitude,
    radius_km: radius,
    webhook_url: webhookUrl,
    webhook_secret: input.webhook_secret ? String(input.webhook_secret) : null,
    thresholds,
    updated_at: new Date().toISOString(),
  };
}

const publicAsset = ({ webhook_secret, ...asset }) => ({ ...asset, has_secret: Boolean(webhook_secret) });
const publicEvent = ({ geometry, ...event }) => ({ ...event, geometry_type: geometry?.type });

/**
 * The service: registry of assets, a poll that matches feeds against them,
 * signed deliveries for new and cleared matches, and JSON snapshots on disk.
 */
export function createService({ baseUrl, dataDir, fetchImpl = fetch, now = () => Date.now(), log = console } = {}) {
  const store = createStore(dataDir);
  let assets = new Map(Object.entries(store.read('assets', {})));
  let matches = new Map(Object.entries(store.read('matches', {})));
  let events = [];
  let feedStatus = {};
  let lastPoll = null;
  let polling = null;
  const persist = () => {
    store.write('assets', Object.fromEntries(assets));
    store.write('matches', Object.fromEntries(matches));
  };

  async function poll() {
    if (polling) return polling;
    polling = (async () => {
      const startedAt = new Date(now()).toISOString();
      const pulled = await fetchEvents({ baseUrl, fetchImpl });
      events = pulled.events;
      feedStatus = pulled.status;
      const current = matchAll(events, [...assets.values()]);
      const currentKeys = new Set();
      const deliveries = [];
      for (const m of current) {
        const key = `${m.assetKey}|${m.eventId}`;
        currentKeys.add(key);
        const known = matches.get(key);
        const escalated = known && severityRank(m.severity) > severityRank(known.severity);
        if (known && !escalated) {
          known.last_seen = startedAt;
          continue;
        }
        const record = { asset: m.assetKey, event: m.eventId, severity: m.severity, reason: m.reason, first_seen: known?.first_seen || startedAt, last_seen: startedAt, delivered: false };
        matches.set(key, record);
        deliveries.push({ type: escalated ? 'hazard.escalated' : 'hazard.matched', match: m, record });
      }
      // Feeds that failed keep their matches; only a healthy feed can clear one.
      for (const [key, record] of matches) {
        if (currentKeys.has(key)) continue;
        const source = record.event.split(':')[0];
        if (!feedStatus[source]?.ok) continue;
        const asset = assets.get(record.asset);
        matches.delete(key);
        if (asset && record.delivered)
          deliveries.push({ type: 'hazard.cleared', match: { asset, event: { id: record.event, severity: record.severity, source }, reason: record.reason }, record });
      }
      for (const d of deliveries) {
        const payload = {
          type: d.type,
          delivery_id: randomUUID(),
          matched_at: startedAt,
          asset: publicAsset(d.match.asset),
          event: publicEvent(d.match.event),
          reason: d.match.reason,
          severity: d.match.event.severity,
        };
        const result = await deliver({ asset: d.match.asset, payload, fetchImpl });
        if (result.ok || result.skipped) d.record.delivered = true;
        store.append('deliveries', result);
        log.info?.(`[alerts] ${d.type} ${d.match.asset.key} <- ${d.match.event.id} ${result.ok ? 'delivered' : result.skipped ? 'no webhook' : `failed (${result.status || result.error})`}`);
      }
      lastPoll = { at: startedAt, events: events.length, matches: matches.size, deliveries: deliveries.length, feeds: feedStatus };
      persist();
      return lastPoll;
    })().finally(() => {
      polling = null;
    });
    return polling;
  }

  return {
    poll,
    listAssets: () => [...assets.values()].map(publicAsset),
    upsertAsset(input) {
      const asset = normalizeAsset(input);
      const previous = assets.get(asset.key);
      if (previous && !asset.webhook_secret) asset.webhook_secret = previous.webhook_secret;
      assets.set(asset.key, asset);
      persist();
      return publicAsset(asset);
    },
    removeAsset(key) {
      const existed = assets.delete(key);
      for (const k of [...matches.keys()]) if (k.startsWith(`${key}|`)) matches.delete(k);
      persist();
      return existed;
    },
    listMatches({ product, asset } = {}) {
      return [...matches.entries()]
        .filter(([key]) => (!asset || key.startsWith(`${asset}|`)) && (!product || key.startsWith(`${product}:`)))
        .map(([key, record]) => ({ key, ...record, event_detail: publicEvent(events.find((e) => e.id === record.event) || { id: record.event }) }));
    },
    listEvents: () => events.map(publicEvent),
    health: () => ({ ok: true, base_url: baseUrl, assets: assets.size, matches: matches.size, events: events.length, last_poll: lastPoll, feeds: feedStatus }),
  };
}
