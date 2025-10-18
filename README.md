# U.S. Incidents Simulator — Mini User-Guide

A lightweight demo that simulates **telecom incidents** across U.S. cities and streams them into MongoDB. A React UI controls the simulator (EPS, spread, concurrency, seed) and shows live status; a Node/Express server generates events and writes them to MongoDB Atlas.

---

## What you see on screen (UI quick tour)

**Simulation Controls (left panel)**

* **Incidents / sec**: Target events per second (EPS) across all workers.
* **Batch size**: Insert batch size per tick; tune for throughput.
* **Concurrency**: Number of worker loops producing events in parallel.
* **Spread (σ factor)**: Scales each city’s `sigmaKm` to control geographic jitter (wider/narrower clouds).
* **Seed (optional)**: If set, makes runs **deterministic** (same cities, jitter, and serviceIssues each run with the same parameters).

**Buttons & indicators**

* **Start Simulator** / **Stop**: Begin/stop generation on the server.
* **Refresh Status**: Polls `/status` (useful when the sim is running elsewhere).
* **IPS/Worker** (chip): Approximate target load per worker = EPS / concurrency.
* **Real IPS (MA)** (green chip): Moving average of actual inserts/sec over a short window.
* **Cities** (blue chip): Size of the currently loaded city model.

**Status panel**
Shows the raw JSON from `/status` so you can verify the live configuration and throughput.

---

## Repository layout

```
simulator/
  server/
    src/
      config.js          # env + sane defaults
      db.js              # Mongo client lifecycle + indexes
      cityModel.js       # loads cities with weight & sigmaKm
      rng.js             # deterministic RNG + gaussian jitter
      serviceIssues.js   # generates embedded telecom issues
      simulator.js       # the event generator engine
      routes.js          # /start /stop /status
      server.js          # express bootstrap + CORS + shutdown
    package.json
    .env.example
    data/
      us-cities.json     # { name, lat, lng, weight, sigmaKm }[]
  web/
    (React UI app — controls & status)
```

---

## Prerequisites

* **Node.js** 18+ (works with 20/22/24)
* **MongoDB Atlas** cluster (or local MongoDB)
* **npm** (or pnpm/yarn)

---

## Setup: Server

1. Install deps and make your env file:

```bash
cd simulator/server
npm i
cp .env.example .env
```

2. Edit `.env`:

```env
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>/
DB_NAME=incidents
COLL_NAME=incident_events
PORT=5050
ALLOWED_ORIGIN=http://localhost:5173
```

3. Run:

```bash
npm run start
# or for auto-reload:
npm run dev
```

You should see:

```
[server] listening on http://localhost:5050
```

### Server endpoints

* `GET /status` → current configuration and moving-average inserts/sec.
* `POST /start` (JSON body)

  ```json
  {
    "eventsPerSec": 8000,
    "batchSize": 1000,
    "concurrency": 1,
    "spread": 2,
    "seed": 1234
  }
  ```
* `POST /stop` → stops all workers gracefully.

### Event document shape (what’s written to MongoDB)

Each insert is a single **incident event**:

```json
{
  "type": "incident",
  "ts": "2025-10-09T16:43:21.511Z",
  "loc": { "type": "Point", "coordinates": [-77.4511, 40.9044] },
  "city": "Aaronsburg",
  "lat": 40.9044,
  "lng": -77.4511,
  "weight": 1,
  "sigmaKm": 5,
  "serviceIssue": {
    "type": "broadband",
    "accountId": "ATTB-102",
    "issue": "slow-speeds",
    "downstreamMbps": 5.4,
    "expectedMbps": 100
  }
}
```

**Notes**

* `lat`/`lng` are top-level for easy consumption by deck.gl.
* `loc` enables geo queries (`2dsphere` index created on startup).
* `weight` and `sigmaKm` are carried from the city model to drive map density/blur.
* `serviceIssue` is randomized per event (wireless, fiber, 5g, enterprise, etc.).

---

## Setup: Web UI

```bash
cd simulator/web
npm i
npm run dev
```

Open the printed URL (typically `http://localhost:5173`).
The UI expects the server at `http://localhost:5050` (CORS is pre-enabled via `ALLOWED_ORIGIN`).

---

## How it works (functional flow)

1. **City model**: `server/data/us-cities.json` contains cities with `{ name, lat, lng, weight, sigmaKm }`.

   * `weight` biases selection frequency (bigger cities → more incidents).
   * `sigmaKm` sets base spread; UI **Spread** multiplies this.

2. **Sampling**:

   * A deterministic RNG (optional **seed**) picks cities weighted by `weight`.
   * Coordinates are jittered around the city center using a Gaussian scaled by `sigmaKm * spread`.

3. **Issue enrichment**:

   * For each event, `serviceIssues.js` creates a telecom-flavored issue object.
   * Many types are modeled (broadband, wireless, fiber, 5g, VPN, backhaul, datacenter, etc.).
   * Some IDs use a short code derived from the city name (first 3 uppercase chars).

4. **Insertion**:

   * Workers insert batches each second to hit the target **Incidents/sec**.
   * `/status` reports a moving average of actual inserts/sec.

---

## Typical workflows

**Start a default 8k EPS simulation**

```bash
# UI: set EPS=8000, Batch=1000, Concurrency=1, Spread=2.0, Seed empty
# Press “Start Simulator”
```

**Reproducible run**

```bash
# Enter a number in Seed (e.g., 42) → same sequence every time with same params.
```

**Stress test**

* Increase **Concurrency** (e.g., 4–8) and adjust **Batch size** (e.g., 2k–5k).
* Watch **Real IPS (MA)** to see actual sustained throughput.

**Map visualizer (future)**

* Feed `lat`, `lng`, and `weight` directly into deck.gl layers (`ScreenGridLayer`, `HexagonLayer`, or `ScatterplotLayer`).
* Use `serviceIssue.type` for color/filters; optionally scale radius by `sigmaKm`.

---

## Troubleshooting

* **Faker method not found**: We avoid version-specific Faker APIs; if you still hit one, update `@faker-js/faker` or paste the provided `serviceIssues.js` (version-agnostic).
* **CORS errors**: Ensure `.env` `ALLOWED_ORIGIN` matches the UI URL.
* **Throughput lower than target**:

  * Increase **Batch size** and/or **Concurrency**.
  * Ensure your Atlas cluster tier can sustain the write rate (monitor metrics).
* **Non-deterministic runs with a seed**:

  * Confirm the seed field is a **number**.
  * If using multiple workers and you want per-worker determinism, we can derive `seed + workerIndex`.

---

## FAQ

**What does “Seed” do?**
Makes the RNG deterministic. Same seed + same params + same city model ⇒ same event stream.

**Why both `lat/lng` and `loc`?**
`lat/lng` for visualization libraries; `loc` for Mongo geospatial queries and indexes.

**Can I point to local MongoDB?**
Yes—set `MONGODB_URI=mongodb://localhost:27017` in `.env`.

**How big is the city model?**
Shown in the UI “Cities” badge (e.g., `20940`). It’s loaded once at server start.

---

## Scripts

**Server**

```bash
cd simulator/server
npm run start   # run
npm run dev     # node --watch
```

**Web**

```bash
cd simulator/web
npm run dev
```

---

## Next steps (ideas)

* Add a “live map” tab in the UI using deck.gl, reading back the last N seconds.
* Toggle filters by `serviceIssue.type` and color by severity.
* Per-worker derived seeds for deterministic parallelism.
* Optional Kafka or Atlas Stream Processing integration for downstream pipelines.

---

Love it—Approach A is perfect for incremental, low-risk changes. Here’s a **step-by-step plan** you can implement in small, testable chunks, keeping your five-collection design intact and showcasing ASP.

---

# Phase 0 — Baseline + Guardrails (no functional change)

**Goal:** Freeze current behavior and add observability so we can measure impact.

* **Checklist**

  * Confirm current polling endpoints and cursors (e.g., `/live?after=<oid>` and per-category reads).
  * Add lightweight counters/logs: inserts/sec per category (server logs are fine).
  * Create 2–3 short “golden runs” (seeded simulator) and capture screenshots/gifs to compare later.

**Acceptance**

* You can start/stop the sim and the visualizer reproduces the same “golden” behavior with a fixed seed.

---

# Phase 1 — Event shape & conventions (doc-only, tiny code constants later)

**Goal:** Agree on the *two* record shapes that will coexist in each category collection.

* **Conventions**

  * Incident inserts (already exist): `kind:"incident"` (add this field going forward; older docs imply incident by absence).
  * Resolution inserts (new): `kind:"resolution"`, `incidentId:ObjectId`, `fixedAt:Date`, `resolution:{…}`, `source:"sim"` (or `"ops"` later).
  * Keep original `_id` for incidents; give resolutions their own `_id` (distinct from `incidentId`) to remain append-only.
  * Index per category: `{ incidentId: 1 }`.

**Acceptance**

* Written down in `README.md` (both repos) + a short ADR note (“Append-only Resolutions”).

---

# Phase 2 — Simulator can *emit* fix candidates (hidden/disabled)

**Goal:** Generate repair intents without publishing them anywhere yet.

* **Changes (simulator/server only)**

  * Add internal queue/mechanism that schedules a “fix intent” for some incidents based on **MTTR** or **Fixes/sec** (off by default).
  * Log “would fix incidentId=X at T=Y” (no DB writes).

**Acceptance**

* With a fixed seed, logs show a stable stream of “would fix” events at the configured rate.

---

# Phase 3 — Introduce a **fix_events** ingest collection

**Goal:** Persist fix intents so ASP can consume them (still disabled for UI).

* **Changes**

  * Simulator writes each scheduled fix into `incidents.fix_events`:

    * Minimal payload: `_id`, `incidentId`, `fixedAt`, `category`, `resolution`.
  * Add `{ incidentId: 1 }` index on `fix_events`.

**Acceptance**

* You can see fix documents accumulating with expected cadence; no changes yet to the category collections or UI.

---

# Phase 4 — ASP routing: fix → category “resolution” insert (smallest ASP change)

**Goal:** For **one** category first (e.g., `infrastructure`), wire a tiny ASP pipeline that reads `fix_events` and inserts a **resolution** doc into `infrastructure_events`.

* **ASP pipeline logic (conceptually)**

  * `$source`: `fix_events`
  * `$match`: `category:"infrastructure"`
  * `$project`: shape → `{ kind:"resolution", incidentId, fixedAt, resolution, meta:{from:"fix_events"} }`
  * `$insert`: into `infrastructure_events`
* **Indexes**

  * Add `{ incidentId: 1 }` on `infrastructure_events` (background).

**Acceptance**

* New docs with `kind:"resolution"` appear in `infrastructure_events` when the simulator’s fix scheduler is enabled.

---

# Phase 5 — UI server: **no endpoint changes**, just pass-through

**Goal:** Confirm the visualizer can **see** the new resolution docs when polling the same category collections.

* **Changes**

  * None to routes; just verify your `/live` reader doesn’t crash on `kind:"resolution"` records.
  * Add temporary logging in the server when it streams a resolution record to the client.

**Acceptance**

* Server logs show it returning both `kind:"incident"` and `kind:"resolution"` for infrastructure.

---

# Phase 6 — UI client: resolution-aware **state** (no animation yet)

**Goal:** Teach the client to remove resolved points from in-memory state when it sees `kind:"resolution"`.

* **State changes**

  * Maintain a `Map<id, point>` per category for currently open points.
  * On `kind:"incident"` → insert into map.
  * On `kind:"resolution"` → `delete(incidentId)` if present; if missing, add to a tiny **resolution buffer** (Set) for e.g. 5–10s and re-check on each new insert (solves out-of-order).
* **UI behavior now**

  * Points vanish immediately (no animation yet), *only* for infrastructure category.

**Acceptance**

* With fixes enabled: infrastructure points get removed over time; other categories behave unchanged.

---

# Phase 7 — Add **fade/shrink animation** on resolve (infrastructure only)

**Goal:** Make the demo delightful.

* **Changes**

  * When a resolution arrives and the point exists, mark it “resolving” and animate opacity/size → 0 over ~300–600ms, then delete from the map.
  * Keep the small buffer for out-of-order resolution arrivals.

**Acceptance**

* Clear, smooth “repair” visuals in infrastructure; perf unaffected.

---

# Phase 8 — Roll out to all categories

**Goal:** Repeat Phases 4–7 for `business`, `consumer`, `emerging_tech`, `federal`.

* **Toggles**

  * Feature flag per category (env or UI control) to enable/disable repairs during testing.

**Acceptance**

* All five categories support resolutions end-to-end; you can toggle them independently.

---

# Phase 9 — Controls & balancing knobs

**Goal:** Make it demo-friendly and stable over long runs.

* **Simulator UI**

  * Add **Fixes/sec** *or* **MTTR (min)** control, plus optional **category multipliers** (e.g., infra = 1.5× repair speed).
* **Visualizer**

  * Add a “Show resolutions in feed” toggle to verify deltas easily.
  * Optionally display a small “Resolved last 1m” counter per category card.

**Acceptance**

* You can balance live open points by turning one knob; donut and totals stabilize.

---

# Phase 10 — Persistence hygiene (optional but nice)

**Goal:** Keep collections compact without deleting history.

* **Options**

  * **TTL on `fix_events`** after N days.
  * **TTL on `resolution` docs** after N days if you don’t need long audits.
  * Or leave history intact and create **ASP-maintained `open_<category>` views** later for fast cold starts.

**Acceptance**

* TTLs work in a test project; no impact on the live demo behavior.

---

# Phase 11 — Edge-case hardening

**Goal:** Make it bulletproof for the webinar.

* **Ordering:** Verify the resolution buffer covers “resolve before add.” Add a periodic (e.g., 30s) reconcile pass that removes any point whose `_id` appears in the last N `resolution` docs.
* **Idempotency:** Multiple resolutions for same incident are no-ops client-side; ASP can `$match` unique (optional).
* **Clock skew:** Prefer server timestamps (`fixedAt` from simulator or ASP) consistently; don’t trust client clock for ordering.
* **Backfill:** Ensure the client ignores old resolution docs on cold start by respecting your `after=<ObjectId>` cursor.

**Acceptance**

* Chaos test: artificially scramble a small set of add/resolve orderings and confirm the UI ends in the correct state.

---

# Phase 12 — Docs & demo script

**Goal:** Ensure repeatability and storytelling.

* Update both READMEs with:

  * Event shapes and indexes
  * How to enable repairs and tune rates
  * A short demo script: “increase incidents → increase fixes → donut stabilizes → watch points resolve”

---

## Rollback plan

* Feature flags allow turning repairs off (sim stops writing `fix_events`; ASP fix pipelines paused; UI ignores `resolution` docs).
* Since category collections remain append-only, no destructive changes are made to existing data.

---

## Milestone summary (what you can test after each)

1. **P0–P1:** No change in behavior; docs updated.
2. **P2–P3:** Fix intents exist (`fix_events`).
3. **P4:** Resolution docs appear in one category.
4. **P5–P6:** That category removes points on resolve.
5. **P7:** It animates.
6. **P8:** All categories behave the same.
7. **P9:** You can balance open count live.
8. **P10–P12:** Hygiene, resilience, and docs are set.

If this plan looks good, I’ll translate Phases 2–4 into exact field names, indexes, and ASP stage snippets next (still minimal and incremental).

