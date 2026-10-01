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

Environment: `PORT` (4180), `GEV_BASE_URL` (http://localhost:4173), `GEV_GATE_PASSWORD` (when the GEV it reads from is behind its login gate), `POLL_MINUTES` (10), `DATA_DIR` (./data), `ADMIN_TOKEN` (when set, every route except `/health`, the reports and `/weekly` needs `Authorization: Bearer <token>`).

## API

- `GET /health` — feed status, counts, last poll.
- `GET /assets` · `POST /assets` (one asset, an array, or `{assets:[...]}`; upsert by `product:id`) · `DELETE /assets/:key`.
- `GET /matches?product=&asset=` — active matches.
- `GET /events` — the normalized events from the last poll (no geometry).
- `POST /poll` — poll now.

Asset fields: `product` (slug), `id`, `tenant_id`, `name`, `latitude`, `longitude`, `radius_km` (0–200), `webhook_url`, `webhook_secret`, `thresholds: { min_severity, heat_feels_like_c }`. An asset may send `city` (and optional `country`, default `IN`) instead of coordinates; the service geocodes it through TomTom, caches the answer, returns the placed asset with a `geocoded` label, and lists anything it could not place under `rejected` instead of registering it somewhere wrong. `GET /geocode?q=&country=` exposes the same lookup.

## Webhook contract

`POST webhook_url` with JSON `{ type, delivery_id, matched_at, asset, event, reason, severity }` where `type` is `hazard.matched`, `hazard.escalated` or `hazard.cleared`. Headers: `X-GEV-Delivery` (id, use it for idempotency), `X-GEV-Event` (the type), `X-GEV-Timestamp`, and `X-GEV-Signature: sha256=<HMAC-SHA256 of the raw body with the asset's webhook_secret>`. Deliveries retry three times on network errors and 5xx; a 4xx is final. Every attempt is appended to `data/deliveries.jsonl`.

State lives in `data/assets.json` and `data/matches.json`; delete them to start clean.

## Road monitor

Records how long named stretches of Chennai's main roads take, every `CORRIDOR_MINUTES` (15), in both directions:

| Road | Outbound stops |
|---|---|
| OMR | Madhya Kailash, Tidel Park, Perungudi, Thoraipakkam, Sholinganallur, Navalur, Siruseri |
| Anna Salai | Kathipara, Saidapet, Nandanam, Teynampet, Gemini, Spencer Plaza, Anna Statue |
| GST Road | Kathipara, Airport, Pallavaram, Chromepet, Tambaram, Perungalathur, Vandalur |
| ECR | Thiruvanmiyur, Kottivakkam, Neelankarai, Injambakkam, Akkarai, Uthandi |

Each sample is one TomTom routing call per road and direction, with live traffic, split at the stops: live minutes, TomTom's usual minutes for this hour, the empty-road minutes (still with signals), and where the route's jams are. Each road is routed end to end once and the stops are snapped onto that path in order, so a stop on a side street or the far carriageway cannot add a loop. Eight corridors every fifteen minutes is 768 calls a day.

This replaced point sampling of TomTom Flow Segment Data on 29 Sep 2026: on OMR the flow API returns one segment for most of the road, so twelve points collapsed into two or three averaged readings and local jams vanished. The earlier point series is kept and shown on the OMR reports.

- `GET /` — the public "Chennai roads today" page: every road now vs usual vs empty road, the slowest stretch, a departure tip, Tamil Nadu alerts, current incidents and trouble spots. Built from stored data only; visitors cost no quota.
- `GET /corridors` · `POST /corridors {name, stops: [{name, lat, lon}, ...]}` · `DELETE /corridors/:id`
- `GET /corridors/:id/report?hours=48` — minutes per stretch, the whole-road chart, typical weekday by departure time, advice.
- `GET /corridors/:id/tips` — the same advice as JSON, with weekday and weekend profiles. `GET /corridors/:id/travel?hours=` — raw totals.
- `POST /corridors/sample` · `POST /corridors/:id/sample` · `POST /corridors/:id/notes {"at": ISO, "text": "..."}`

Findings follow rules written so they hold up in front of officials (all on `/methodology`):

- The reference is our own night-time drive (quickest typical slot before 05:30), not TomTom's no-traffic time, which is slower than real night drives here.
- "Typical" is the median of a 30-minute departure slot; "most days" is its 10th–90th percentile range.
- Each rush is found over the whole day: the peak in the morning (05:00–13:00) or later (13:00–24:00), and the span where the road stays at least 30% of the way from night-time to peak. No fixed window can turn its edge into advice.
- A departure shift is advised only if it saves at least 6 minutes within an hour of the peak; otherwise the page says there is no quick win.
- A stretch is named as the bottleneck only if it carries a third of the extra time and 1.5 times the next stretch's; otherwise the delay is "spread".
- Each road is labelled live observation or mostly TomTom's model (whether live departs from TomTom's typical time by 2 minutes or 5% in at least 15% of readings), and early (<5 weekdays), provisional (5–9) or established (10+). Weekly reports keep early findings apart from established ones.
- Cross-road notes call out a road that peaks in the morning when most peak in the evening, and directions that peak an hour or more apart.

Rain: Open-Meteo hourly rainfall at one point per road (`RAIN_MINUTES`, default 60), shaded on charts and compared with typical in the weekly report. Tamil Nadu public holidays are seeded as notes on every road.

Daily roll-up: every finished IST day is summarised per road and 30-minute slot (median, range, TomTom typical and no-traffic, observed share, rain, per-stretch medians) in `route_slot_daily`. `GET /export/slots.csv?from=&to=&corridor=` returns it (admin token unless `EXPORT_PUBLIC=1`, pending TomTom's view on sharing derived data). `RAW_RETENTION_DAYS` (default 0, keep) deletes raw readings older than that once their day is rolled up, for TomTom's storage limits. `POST /rollup` runs the roll-up now.

`GET /methodology` is the public method page: definitions, each road's status and source, known limits, licensing, events on record.

## Incidents and trouble spots

Every `INCIDENT_MINUTES` (15) the service records TomTom's live incidents for the Chennai box (`INCIDENT_BBOX`, default `80.0,12.75,80.35,13.25`): accidents, jams, closures, roadworks, flooding, breakdowns. Each incident is kept once with first and last sighting. Trouble spots group incidents into ~330 m cells, weighting accidents 5, flooding 3, breakdowns 2 and a major jam 1 per day; planned closures and roadworks do not count. They show where trouble recurs; they are not official accident records. In practice TomTom reports almost no accidents in Chennai, so the page shows two lists: recurring jams (a major jam on two or more days, ranked by days seen then typical delay) and accident/flooding spots, which stay empty until such reports appear. `GET /incidents?days=30` returns current incidents, recurring jams and safety spots.

On a laptop, set `CORRIDOR_MINUTES=0` and `INCIDENT_MINUTES=0` when a hosted copy records with the same TomTom key (`run-alerts.sh` does).

## Weekly report

Each road and direction for the week just completed (Monday to Sunday, IST): weekday morning and evening peak minutes, the worst drive and when, the change from the week before, the stretch carrying the delay, departure advice, plus the city's incidents and trouble spots and the week's notes. Email-safe HTML, one headline sentence per corridor.

- `GET /weekly` — the last completed week, HTML. `GET /weekly/2026-W39` for a given ISO week; add `.json` for the numbers.
- `POST /weekly/send?week=&send=1` — build now and email (admin token). `send=0` only builds.

Email needs `SMTP_USER`, `SMTP_PASS` (for Hostinger: the mailbox password, with `SMTP_HOST` smtp.hostinger.com and `SMTP_PORT` 465) (a Gmail app password works; `SMTP_HOST` smtp.gmail.com and `SMTP_PORT` 465 are the defaults) and `REPORT_TO` (comma-separated). `REPORT_FROM` overrides the sender, `REPORT_BASE_URL` makes the "open the live report" links absolute, and `REPORT_DAY` (1 = Monday) with `REPORT_HOUR` (7, IST) sets when it goes out. Each week's summary is saved under `data/weekly/` so past reports stay readable.

If sending fails the service waits 30 minutes before trying again; after a login failure (or three failures) it stops until the mail settings change, so a wrong password cannot get the mailbox locked. `GET /health` shows the mail settings in use (never the password), the last attempt and the last error.

## Second source: Google

With `GOOGLE_ROUTES_API_KEY` (a key restricted to the Routes API), once per scheduled IST hour (`GOOGLE_CHECK_HOURS`, default `3,6-23`) and right after a TomTom round, the service asks Google's Routes API (`TRAFFIC_AWARE`) for the same drive through the same waypoints and compares it with the TomTom reading of that moment. Google Maps Platform's Service Specific Terms (§19.3, Routes API) allow caching only latitude/longitude for 30 days, so Google's numbers are discarded: the `crosscheck` table keeps only the outcome (within 10% / within 20% / TomTom higher / TomTom lower / route differs / error), whether both sources saw congestion (live ≥ 120% of each source's no-traffic time), and how many stretches agreed within 20%. Eight roads × 19 checks a day stays under Compute Routes Pro's free 5,000 a month; `GOOGLE_MONTHLY_CAP` (4,800) stops it for the month before that. Agreement shows on `/methodology` and in the weekly report; `POST /crosscheck` (admin) runs one now.

A road direction is fit for formal use when it is established (10+ weekdays) and has at least 50 Google comparisons with at least 80% within 20% (`FORMAL` in `src/crosscheck.mjs`). The methodology page, each road's report, the public page and the weekly email all show this status; anything short of it is labelled as an observation, not a finding.

## Timed drives (ground truth)

`/drive` is a phone page for logging a real drive along a monitored road. It uses the map password (`GEV_GATE_PASSWORD`, or `ADMIN_TOKEN`) sent as `X-Drive-Key`; ten wrong attempts from one address lock it for fifteen minutes. Pick the road and direction, tap Start at the first junction: the server asks TomTom (stored) and Google (held in memory until the finish, then reduced to an agreement band) for the predicted drive. The page records GPS every few seconds with the screen kept awake, shows junctions as they pass, keeps the drive on the phone if the upload fails, and finishes on arrival. The server finds each junction's passing time (closest approach within 150 m, in order, interpolated), checks the drive stayed within 200 m of the road for 90% of the way and had no GPS gap over two minutes, and compares the real times with the predictions. `GET /drives` lists results without tracks or notes; `GET /drives/:id/track` needs the key. Results appear on `/methodology` under "Ground truth".
