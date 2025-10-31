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
