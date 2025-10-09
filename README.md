# US Pickup Simulator — Mini User Manual (Web UI)

This guide explains every element in the Simulator web app and how it maps to behavior on the server. Use it as a quick “how-to” and as technical reference.

---

## Overview

The Simulator generates synthetic “pickup” events (GeoJSON points around U.S. cities) and writes them to MongoDB Atlas.
The server loads a **static city catalog** (`simulator/server/data/us-cities.json`, ~20,940 cities) at startup and samples from it with weighted probability. The UI is a thin control panel for starting, stopping, and monitoring throughput.

---

## Layout at a Glance

* **Title** — “US Pickup Simulator”
* **Simulation Controls** (single card)

  * **Events / sec**
  * **Batch size**
  * **Concurrency**
  * **Spread (σ factor)** — slider
  * **Seed (optional)**
  * **Start Simulator / Stop**
  * **Refresh Status**
  * **Status Pills** (Running/Stopped, EPS/worker, Real EPS (MA), Cities)
  * **Live Status JSON** (read-only diagnostics)

---

## Controls (left to right, top to bottom)

### 1) Events / sec

* **What it is:** Target number of documents to insert per second across all workers.
* **Type / Range:** Integer ≥ 1 (UI enforces minimum; step = 100).
* **How it works:** The server splits this rate across `concurrency` workers (see “EPS/worker” pill). Inserts are performed in batches (see “Batch size”).
* **Tip:** If you set `events/sec < concurrency`, Start is disabled (guardrail).

### 2) Batch size

* **What it is:** Number of docs per `insertMany()` call.
* **Type / Range:** Integer ≥ 1 (step = 100).
* **Trade-offs:**

  * Larger batches → higher throughput, fewer round trips, but higher per-op latency and bigger spikes on failure.
  * Smaller batches → smoother flow, more overhead.

### 3) Concurrency

* **What it is:** Number of logical workers (parallel emitters) sharing the total EPS.
* **Type / Range:** Integer between 1 and 128.
* **How it works:** The server computes an even split:

  * `base = floor(eventsPerSec / concurrency)`
  * First `eventsPerSec % concurrency` workers get +1 EPS to cover the remainder.
* **Use cases:**

  * Mimic multiple clients/producers.
  * Observe how throughput scales with moderate parallelism.

### 4) Spread (σ factor)

* **What it is:** Multiplier applied to each city’s `sigmaKm` when jittering a point around its center using a Gaussian (Box–Muller).
* **Type / Range:** Continuous 0.2 → 5.0 (step = 0.1).
* **Effect:** Higher spread = wider dispersion from each city’s coordinates.
* **Default behavior:** If a city lacks `sigmaKm`, the server uses `10` (km).

### 5) Seed (optional)

* **What it is:** Optional numeric seed for deterministic random sampling.
* **Type:** Number or empty. Empty = unseeded (true random).
* **Effect:** When set, both city selection and jitter are reproducible.

### 6) Start Simulator / Stop

* **Start Simulator:** Sends a `POST /start` with the current parameters.

  * Disabled when `eventsPerSec < concurrency`.
* **Stop:** Sends `POST /stop` to halt all workers.
* **Server behavior:** The worker loop runs at 1-second ticks, creating `batches = ceil(epsForWorker / batchSize)` batches and inserting them via `insertMany()`.

### 7) Refresh Status

* **What it is:** Manual fetch of `/status`.
* **Note:** The UI also polls automatically about every 2.5 seconds.

---

## Status Pills

These small badges provide quick readouts from the last `/status` response.

### A) Running / Stopped

* **What it shows:** Whether the server is actively ticking workers (`SIM.running`).
* **Colors:**

  * **Running** — green
  * **Stopped** — gray

### B) ~N eps/worker

* **What it shows:** Approximate EPS load per worker based on your inputs.
  `floor(eventsPerSec / concurrency)`, plus remainder distributed to early workers.
* **Why it matters:** Helps reason about per-thread load and batching behavior.

### C) Real EPS (MA): X

* **What it shows:** Moving-average of actual inserts/sec as measured by the server.
* **Source:** `/status.insertsPerSecMA` computed from a sliding history.
* **Window:** `/status.insertsPerSecWindow` seconds (default 10s).
* **Interpretation:**

  * Close to target EPS → healthy pipeline.
  * Significantly lower → check network, cluster write capacity, indexes, or reduce `batch size` / `spread` / `concurrency`.

### D) Cities: 20940

* **What it shows:** Number of cities the server has currently loaded (`/status.cityModelSize`).
* **Note:** Read-only. The server loads `data/us-cities.json` at startup.

---

## Live Status JSON (diagnostics)

The read-only block shows the raw `/status` payload, for example:

```json
{
  "running": false,
  "eventsPerSec": 8000,
  "batchSize": 1000,
  "spread": 2,
  "seed": null,
  "concurrency": 1,
  "cityModelSize": 20940,
  "insertsPerSecMA": 8000,
  "insertsPerSecWindow": 10
}
```

### Field reference

* **running** — Whether the worker loop is active.
* **eventsPerSec / batchSize / spread / seed / concurrency** — Echo of the active simulator parameters.
* **cityModelSize** — Count of cities loaded on the server (read-only).
* **insertsPerSecMA** — Server-measured inserts/sec moving average.
* **insertsPerSecWindow** — Size of the moving-average window (seconds).

---

## How Parameters Affect Event Generation

1. **City selection:** Weighted random pick from the in-memory city catalog using a cumulative weight array (binary search).
2. **Point jitter:** For each selected city, a point is sampled via Gaussian noise around the city center. `sigmaKm * spread` controls the radius.
3. **Batching:** Each worker aggregates documents into batches and writes with `insertMany({ ordered: false })`.
4. **Throughput accounting:** The server tallies the number of inserted docs per second and updates the moving average.

---

## Best-Practice Recipes

* **High, smooth throughput:**

  * Increase **Batch size** (e.g., 2k–10k)
  * Moderate **Concurrency** (2–8)
  * Ensure target Atlas cluster can absorb the write rate (check IOPS/WT cache)

* **Bursty demo:**

  * Keep **Batch size** moderate (500–1000)
  * Increase **Concurrency** briefly (e.g., 16–32)
  * Show how **Real EPS (MA)** ramps and how ASP/consumers react

* **Deterministic replay:**

  * Set a numeric **Seed**
  * Keep the same params across runs
  * Compare identical outputs or profiling results

---

## Troubleshooting

* **Real EPS (MA) << target EPS**

  * Atlas write limits: lower **Events / sec** or **Batch size**.
  * Network/latency: run server closer to Atlas region.
  * Index pressure: ensure only essential indexes (we already create `{ ts:1 }` and `loc: "2dsphere"`).

* **Start button disabled**

  * `events/sec` must be **≥ concurrency**.

* **Status JSON not updating**

  * Check server logs.
  * Click **Refresh Status**.
  * Verify `VITE_SIM_BASE` in the web app is pointing at the correct server.

---

## Server Mapping (for engineers)

* **POST `/start`**
  Body: `{ eventsPerSec, batchSize, spread, seed|null, concurrency }`
  Effect: Starts/refreshes the per-second timer and worker split.

* **POST `/stop`**
  Effect: Clears the timer; sets `running = false`.

* **GET `/status`**
  Returns simulator parameters, `cityModelSize`, and throughput metrics.

* **Data source:** `simulator/server/data/us-cities.json` loaded at server startup; city model can be hot-swapped via `/model` (not exposed in UI).

---

## Quick Workflow

1. Set **Events / sec**, **Batch size**, **Concurrency**, **Spread**, and optional **Seed**.
2. Click **Start Simulator**.
3. Watch **Real EPS (MA)** and **Cities** pills.
4. Inspect the **Status JSON** for the exact active parameters.
5. Click **Stop** when done.
