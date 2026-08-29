# Incident Simulator — Mini User-Guide

A lightweight demo that simulates **telecom incidents** across U.S. cities and streams them into MongoDB. A React UI controls the simulator (EPS, spread, concurrency, seed) and shows live status; a Node/Express server generates events and writes them to MongoDB Atlas.

---

## Features

- **Continuous Mode**: Stream incidents indefinitely at configurable events/sec
- **Repeatable Mode**: Generate a fixed dataset with deterministic seeding
- **Multimodal Image Embeddings**: Attach AI-generated images with VoyageAI embeddings
- **Local & GCS Image Sources**: Use local files or Google Cloud Storage
- **Repair Scheduler**: Simulate incident resolution with configurable delays
- **Scenario Injection**: Pre-defined incident scenarios for demos

---

## What you see on screen (UI quick tour)

**Simulation Controls (left panel)**

* **Incidents / sec**: Target events per second (EPS) across all workers.
* **Batch size**: Insert batch size per tick; tune for throughput.
* **Concurrency**: Number of worker loops producing events in parallel.
* **Spread (σ factor)**: Scales each city's `sigmaKm` to control geographic jitter (wider/narrower clouds).
* **Seed (optional)**: If set, makes runs **deterministic** (same cities, jitter, and serviceIssues each run with the same parameters).

**Generation Mode**

* **Continuous**: Streams indefinitely until stopped
* **Repeatable**: Generates a fixed count, then auto-stops. Uses dataset name as seed.

**Media Attachments** (Repeatable mode only)

* **Attach Images**: Enable multimodal embeddings (~30% of incidents)
* **Image Source**: Local filesystem or GCS bucket
* **Dataset**: Select which image dataset to use

**Buttons & indicators**

* **Start Simulator** / **Stop**: Begin/stop generation on the server.
* **Refresh Status**: Polls `/status` (useful when the sim is running elsewhere).
* **IPS/Worker** (chip): Approximate target load per worker = EPS / concurrency.
* **Real IPS (MA)** (green chip): Moving average of actual inserts/sec over a short window.
* **Cities** (blue chip): Size of the currently loaded city model.
* **Media** (blue chip): Count of media documents created with embeddings.

**Status panel**
Shows the raw JSON from `/status` so you can verify the live configuration and throughput.

---

## Repository layout

```
incident-simulator/
  server/
    src/
      config.js          # env + sane defaults
      db.js              # Mongo client lifecycle + indexes
      cityModel.js       # loads cities with weight & sigmaKm
      rng.js             # deterministic RNG + gaussian jitter
      serviceIssues.js   # generates embedded telecom issues
      simulator.js       # the event generator engine
      mediaService.js    # image selection + VoyageAI embeddings
      voyageai.js        # Atlas Embedding API client
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

### For Multimodal Image Embeddings (optional)

* **Atlas Model API Key** - For VoyageAI embeddings via MongoDB Atlas
* **Generated Images** - Either local or in GCS bucket

### For GCS Image Source (optional)

* **Google Cloud SDK** - `gcloud` CLI installed and authenticated
* **GCS Service Account** - With `Storage Object Admin` role on your bucket
* **Service Account Key** - JSON key file for authentication

---

## Setup: Server

1. Install deps and make your env file:

```bash
cd incident-simulator/server
npm i
cp .env.example .env
```

2. Edit `.env`:

```env
# MongoDB connection
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>/
DB_NAME=incidents
COLL_NAME=incident_events
PORT=5050
ALLOWED_ORIGIN=http://localhost:5173

# Atlas Model API (VoyageAI multimodal embeddings)
ATLAS_MODEL_API_KEY=your-atlas-model-api-key

# Media attachment settings
MEDIA_ENABLED=true
MEDIA_ATTACHMENT_RATE=0.3

# Media source: 'local' or 'gcs'
MEDIA_SOURCE=local

# Local file system source
MEDIA_IMAGES_DIR=/path/to/generated-images-data/demo-v1

# GCS bucket source (requires GOOGLE_APPLICATION_CREDENTIALS)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
MEDIA_GCS_BUCKET=incident-app
MEDIA_DATASET=demo-v1
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

---

## Setup: GCS Image Storage

To use images from Google Cloud Storage instead of local files:

### 1. Create a GCS Bucket

```bash
gsutil mb gs://your-bucket-name
```

### 2. Create a Service Account

1. Go to GCP Console → IAM → Service Accounts
2. Create a new service account (e.g., `incident-app-storage`)
3. **Do not** assign project-level roles

### 3. Grant Bucket-Level Permissions

```bash
gsutil iam ch serviceAccount:incident-app-storage@YOUR_PROJECT.iam.gserviceaccount.com:objectAdmin gs://your-bucket-name
```

This grants full object access within the bucket only.

### 4. Create and Download Key

1. Service Account → Keys → Add Key → Create new key
2. Select JSON format
3. Save to a secure location (e.g., `creds/service-account-key.json`)

### 5. Upload Images to GCS

Structure your images like this:

```
gs://your-bucket/
  incident-media/
    datasets/
      demo-v1/
        manifest.json
        images/
          business/
            b2b-001.png
            ...
          consumer/
          emerging_tech/
          federal/
          infrastructure/
```

Upload with:

```bash
gsutil cp manifest.json gs://your-bucket/incident-media/datasets/demo-v1/
gsutil -m cp -r images/* gs://your-bucket/incident-media/datasets/demo-v1/images/
```

### 6. Configure .env

```env
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
MEDIA_GCS_BUCKET=your-bucket-name
MEDIA_DATASET=demo-v1
MEDIA_SOURCE=gcs
```

---

## Setup: Atlas Model API

To enable multimodal image embeddings:

### 1. Get Atlas Model API Key

1. Go to MongoDB Atlas → Project → AI Models (or Model API Keys)
2. Create a new API key
3. Copy the key (starts with `al-`)

### 2. Configure .env

```env
ATLAS_MODEL_API_KEY=al-your-api-key-here
MEDIA_ENABLED=true
```

### 3. Create Vector Search Index (for search functionality)

In Atlas UI, create a vector search index on `incident_media` collection:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1024,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "simRunId"
    },
    {
      "type": "filter",
      "path": "category"
    }
  ]
}
```

---

## Server endpoints

* `GET /status` → current configuration and moving-average inserts/sec.
* `POST /start` (JSON body)

  ```json
  {
    "eventsPerSec": 8000,
    "batchSize": 1000,
    "concurrency": 1,
    "spread": 2,
    "seed": 1234,
    "genMode": "repeatable",
    "repeatableCount": 1000,
    "mediaEnabled": true,
    "mediaSource": "gcs",
    "mediaDataset": "demo-v1"
  }
  ```
* `POST /stop` → stops all workers gracefully.

### Event document shape (what's written to MongoDB)

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
    "category": "consumer",
    "accountId": "ATTB-102",
    "issue": "slow-speeds",
    "downstreamMbps": 5.4,
    "expectedMbps": 100
  },
  "simRunId": "20251009-1643Z-s42"
}
```

### Media document shape (incident_media collection)

```json
{
  "incidentId": ObjectId("..."),
  "simRunId": "20251009-1643Z-s42",
  "mediaType": "image",
  "category": "consumer",
  "type": "broadband",
  "filename": "broadband-abc123.png",
  "source": "gcs",
  "dataset": "demo-v1",
  "caption": "consumer incident in Aaronsburg, PA: ...",
  "embedding": [0.023, -0.041, ...],  // 1024 dimensions
  "ts": "2025-10-09T16:43:21.600Z"
}
```

**Notes**

* `lat`/`lng` are top-level for easy consumption by deck.gl.
* `loc` enables geo queries (`2dsphere` index created on startup).
* `weight` and `sigmaKm` are carried from the city model to drive map density/blur.
* `serviceIssue` is randomized per event (wireless, fiber, 5g, enterprise, etc.).
* `embedding` is a 1024-dimensional vector from `voyage-multimodal-3.5`.

---

## Setup: Web UI

```bash
cd incident-simulator/web
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

4. **Media attachment** (Repeatable mode):

   * ~30% of incidents get an image attached (configurable via `MEDIA_ATTACHMENT_RATE`)
   * Image selected based on incident category and type
   * Caption generated from incident narrative
   * Image + caption embedded via Atlas Model API (`voyage-multimodal-3.5`)
   * 1024-dimensional vector stored in `incident_media` collection

5. **Insertion**:

   * Workers insert batches each second to hit the target **Incidents/sec**.
   * `/status` reports a moving average of actual inserts/sec.

---

## Typical workflows

**Start a default 8k EPS simulation**

```bash
# UI: set EPS=8000, Batch=1000, Concurrency=1, Spread=2.0, Seed empty
# Press "Start Simulator"
```

**Reproducible run with media**

```bash
# UI: Select "Repeatable" mode
# Set Dataset Name: "demo-v1"
# Set Count: 1000
# Check "Attach Images"
# Select "GCS Bucket" and Dataset: "demo-v1"
# Press "Start Simulator"
```

**Stress test**

* Increase **Concurrency** (e.g., 4–8) and adjust **Batch size** (e.g., 2k–5k).
* Watch **Real IPS (MA)** to see actual sustained throughput.

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
* **Media service not ready**:

  * Check `ATLAS_MODEL_API_KEY` is set
  * For local: ensure `MEDIA_IMAGES_DIR` points to images
  * For GCS: ensure `GOOGLE_APPLICATION_CREDENTIALS` points to valid key

* **GCS access denied**:

  * Verify service account has `Storage Object Admin` on the bucket
  * Check `GOOGLE_APPLICATION_CREDENTIALS` path is correct
  * Test with: `gsutil ls gs://your-bucket/`

---

## FAQ

**What does "Seed" do?**
Makes the RNG deterministic. Same seed + same params + same city model ⇒ same event stream.

**Why both `lat/lng` and `loc`?**
`lat/lng` for visualization libraries; `loc` for Mongo geospatial queries and indexes.

**Can I point to local MongoDB?**
Yes—set `MONGODB_URI=mongodb://localhost:27017` in `.env`.

**How big is the city model?**
Shown in the UI "Cities" badge (e.g., `20940`). It's loaded once at server start.

**What model is used for embeddings?**
`voyage-multimodal-3.5` via MongoDB Atlas Embedding API. Returns 1024-dimensional vectors.

**Can I use my own images?**
Yes! Organize them by category folder, generate a manifest.json, and point to the directory (local) or upload to GCS.

---

## Scripts

**Server**

```bash
cd incident-simulator/server
npm run start   # run
npm run dev     # node --watch
```

**Web**

```bash
cd incident-simulator/web
npm run dev
```

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGODB_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `DB_NAME` | `incidents` | Database name |
| `COLL_NAME` | `incident_events` | Collection name |
| `PORT` | `5050` | Server port |
| `ALLOWED_ORIGIN` | `http://localhost:5173` | CORS allowed origin |
| `ATLAS_MODEL_API_KEY` | - | Atlas Model API key for embeddings |
| `MEDIA_ENABLED` | `false` | Enable media attachments by default |
| `MEDIA_ATTACHMENT_RATE` | `0.3` | Fraction of incidents to attach media |
| `MEDIA_SOURCE` | `local` | Image source: `local` or `gcs` |
| `MEDIA_IMAGES_DIR` | `../scripts/generated-images-data/demo-v1` | Local images directory |
| `MEDIA_GCS_BUCKET` | `incident-app` | GCS bucket name |
| `MEDIA_DATASET` | `demo-v1` | Dataset name in GCS |
| `GOOGLE_APPLICATION_CREDENTIALS` | - | Path to GCS service account key |

---

## Next steps (ideas)

* Add a "live map" tab in the UI using deck.gl, reading back the last N seconds.
* Toggle filters by `serviceIssue.type` and color by severity.
* Per-worker derived seeds for deterministic parallelism.
* Optional Kafka or Atlas Stream Processing integration for downstream pipelines.
* Vector search across incident images using multimodal embeddings.
