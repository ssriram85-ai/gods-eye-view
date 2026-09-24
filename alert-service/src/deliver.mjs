import { createHmac, randomUUID } from 'node:crypto';

/** HMAC-SHA256 over the exact bytes sent; receivers verify against the raw body. */
export function sign(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * POST one signed webhook with bounded retries. Never throws; returns the
 * delivery record so the caller can log it.
 */
export async function deliver({ asset, payload, fetchImpl = fetch, attempts = 3, backoffMs = 2_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deliveryId = payload.delivery_id || randomUUID();
  const body = JSON.stringify({ ...payload, delivery_id: deliveryId });
  const record = { delivery_id: deliveryId, asset: asset.key, type: payload.type, event: payload.event?.id, attempts: 0, status: null, ok: false, at: new Date().toISOString() };
  if (!asset.webhook_url) return { ...record, skipped: 'no webhook_url' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    record.attempts = attempt;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const r = await fetchImpl(asset.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'gev-alert-service/0.1',
          'X-GEV-Delivery': deliveryId,
          'X-GEV-Event': payload.type,
          'X-GEV-Timestamp': String(Date.now()),
          ...(asset.webhook_secret ? { 'X-GEV-Signature': sign(body, asset.webhook_secret) } : {}),
        },
        body,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      record.status = r.status;
      if (r.ok) {
        record.ok = true;
        return record;
      }
      // 4xx other than 408/429 will not change on retry.
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return record;
    } catch (error) {
      record.error = error.message;
    }
    if (attempt < attempts) await sleep(backoffMs * attempt);
  }
  return record;
}
