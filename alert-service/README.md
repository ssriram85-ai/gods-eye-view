# GEV alert service

A small geofence service between God's Eye View's hazard feeds and the products that need to act on them. Products register assets (a warehouse, a clinic, a supplier route point) with coordinates and a webhook. Every ten minutes the service pulls GEV's feeds, matches every event against every asset, and delivers a signed webhook when a match appears, escalates, or clears.

Feeds and what counts as a match:

| Feed | GEV endpoint | Match rule | Severity |
|---|---|---|---|
| NDMA SACHET alerts | `/api/sachet` | asset inside the alert polygon (or within `radius_km` of it) | Extreme → critical, Severe → warning, else info |
| JTWC cyclone warnings | `/api/jtwc` | inside the 34-knot danger swath; or within 150 km of the forecast track | swath critical, corridor warning |
| Heat stress | `/api/heat-stress` | within 40 km of a catalog city whose feels-like peak is at or above the asset's `heat_feels_like_c` (default 41 °C) | 41°+ critical, 32°+ warning |

An asset's `thresholds.min_severity` (default `warning`) filters what it is told about. A feed that fails to load keeps its existing matches; only a healthy feed can clear one.

## Run

```bash
~/Desktop/GEV/run-gev.sh      # GEV must be up (feeds)
~/Desktop/GEV/run-alerts.sh   # this service on http://127.0.0.1:4180
```

Environment: `PORT` (4180), `GEV_BASE_URL` (http://localhost:4173), `POLL_MINUTES` (10), `DATA_DIR` (./data), `ADMIN_TOKEN` (when set, every route except `/health` needs `Authorization: Bearer <token>`).

## API

- `GET /health` — feed status, counts, last poll.
- `GET /assets` · `POST /assets` (one asset, an array, or `{assets:[...]}`; upsert by `product:id`) · `DELETE /assets/:key`.
- `GET /matches?product=&asset=` — active matches.
- `GET /events` — the normalized events from the last poll (no geometry).
- `POST /poll` — poll now.

Asset fields: `product` (slug), `id`, `tenant_id`, `name`, `latitude`, `longitude`, `radius_km` (0–200), `webhook_url`, `webhook_secret`, `thresholds: { min_severity, heat_feels_like_c }`.

## Webhook contract

`POST webhook_url` with JSON `{ type, delivery_id, matched_at, asset, event, reason, severity }` where `type` is `hazard.matched`, `hazard.escalated` or `hazard.cleared`. Headers: `X-GEV-Delivery` (id, use it for idempotency), `X-GEV-Event` (the type), `X-GEV-Timestamp`, and `X-GEV-Signature: sha256=<HMAC-SHA256 of the raw body with the asset's webhook_secret>`. Deliveries retry three times on network errors and 5xx; a 4xx is final. Every attempt is appended to `data/deliveries.jsonl`.

State lives in `data/assets.json` and `data/matches.json`; delete them to start clean.
