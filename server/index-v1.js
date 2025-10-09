// What this does
// * Accepts a city model via POST /model (you can POST your us_metro_model.json from the UI).
// * POST /start begins emitting documents into uber.pickups_sim at your chosen events/sec
//   and batch size, using either:
//     * mode: "catalog" → weighted sampling from your city list (recommended)
//     * mode: "randomUS" → uniform random across US bounds
// * Each document is a single pickup event (GeoJSON loc, ts, plus city and base metadata).

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';

const {
  MONGODB_URI,
  DB_NAME = 'uber',
  COLL_NAME = 'pickups_sim',
  PORT = 5050,
  ALLOWED_ORIGIN = 'http://localhost:5173'
} = process.env;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in .env'); process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGIN }));

// ---- Mongo ----
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(DB_NAME);
const coll = db.collection(COLL_NAME);

// Helpful index for geospatial queries & time windows
await coll.createIndex({ ts: 1 });
await coll.createIndex({ 'loc': '2dsphere' });

console.log(`Connected to MongoDB → ${DB_NAME}.${COLL_NAME}`);

// belt-and-suspenders guard so this never crashes the process
process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

// ---- City model helpers ----
// --- Throughput stats ---
let STATS = {
  lastSecondInserts: 0,   // inserts counted in the current 1s interval
  maWindow: 10,           // seconds for moving average
  history: []             // last N seconds of counts
};

let CITY_MODEL = [];
// Prefer serving this from the web app (so you can edit easily), but you can also drop a copy here:
// try { CITY_MODEL = JSON.parse(fs.readFileSync('./city-model.json','utf8')); } catch {}
// The server can also accept a model POST from the UI if you want; for now we fetch from the web app at runtime.

const US_BOUNDS = { minLat: 24.5, maxLat: 49.5, minLng: -125, maxLng: -66 };

const rand = (seedObj) => {
  // simple LCG for reproducibility when seed set
  if (!seedObj) return Math.random();
  seedObj.value = (1664525 * seedObj.value + 1013904223) % 4294967296;
  return seedObj.value / 4294967296;
};

function kmToDegLat(km) { return km / 110.574; }
function kmToDegLng(km, latDeg) { return km / (111.320 * Math.cos((latDeg * Math.PI) / 180)); }
function randn(seedObj) {
  // Box–Muller using seeded or Math.random
  const r = () => rand(seedObj) || Math.random();
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function pickWeightedCity(seedObj) {
  const total = CITY_MODEL.reduce((s, m) => s + (m.weight || 1), 0);
  let r = (rand(seedObj) || Math.random()) * total;
  for (const m of CITY_MODEL) {
    r -= (m.weight || 1);
    if (r <= 0) return m;
  }
  return CITY_MODEL[CITY_MODEL.length - 1];
}

function randomUSCity(seedObj) {
  const r = (a, b) => (a + (b - a) * (rand(seedObj) || Math.random()));
  const lat = r(US_BOUNDS.minLat, US_BOUNDS.maxLat);
  const lng = r(US_BOUNDS.minLng, US_BOUNDS.maxLng);
  return { name: 'Random-US', lat, lng, sigmaKm: 10, weight: 1 };
}

function sampleAround({ lat, lng, sigmaKm = 10 }, spread = 1.0, seedObj) {
  const sx = sigmaKm * spread;
  const dxKm = randn(seedObj) * sx;
  const dyKm = randn(seedObj) * sx;
  const lng2 = lng + kmToDegLng(dxKm, lat);
  const lat2 = lat + kmToDegLat(dyKm);
  return { lat: lat2, lng: lng2 };
}

function movingAverage() {
  if (!STATS.history.length) return 0;
  const sum = STATS.history.reduce((a,b) => a + b, 0);
  return Math.round(sum / STATS.history.length);
}

// ---- Simulation State ----
let SIM = {
  running: false,
  mode: 'catalog',         // 'catalog' | 'randomUS'
  eventsPerSec: 5000,
  batchSize: 1000,
  spread: 2.0,
  seed: null,
  concurrency: 1,          // <-- NEW
  timer: null
};

// --- keep near the SIM declaration ---
function serializeSim() {
  // Strip non-serializable fields
  const { timer, ...rest } = SIM;
  return rest;
}

function makeEvent(baseCity, jittered) {
  const ts = new Date();
  const doc = {
    ts,
    city: baseCity.name,
    base: { lat: baseCity.lat, lng: baseCity.lng, sigmaKm: baseCity.sigmaKm ?? 10, weight: baseCity.weight ?? 1 },
    loc: { type: 'Point', coordinates: [jittered.lng, jittered.lat] },
    lat: jittered.lat,
    lng: jittered.lng,
    source: 'sim',
    // example extra fields your ASP can aggregate:
    rgn: baseCity.rgn || null,
    weight: 1
  };
  return doc;
}

async function tick(epsForThisWorker) {
  const { batchSize, spread, mode, seed } = SIM;
  const seedObj = seed != null ? { value: seed >>> 0 } : null;
  const batches = Math.max(1, Math.ceil(epsForThisWorker / batchSize));
  const effectiveBatch = Math.max(1, Math.floor(epsForThisWorker / batches));

  for (let b = 0; b < batches; b++) {
    const docs = new Array(effectiveBatch);
    for (let i = 0; i < effectiveBatch; i++) {
      const base = (mode === 'catalog' && CITY_MODEL.length > 0)
        ? pickWeightedCity(seedObj)
        : randomUSCity(seedObj);
      const p = sampleAround(base, spread, seedObj);
      docs[i] = makeEvent(base, p);
    }
    //coll.insertMany(docs, { ordered: false }).catch(() => {});
    coll.insertMany(docs, { ordered: false })
        .then(res => { STATS.lastSecondInserts += (res?.insertedCount || docs.length); })
        .catch(() => { /* optional: log errors */ });
  }
}


// ---- API ----
app.get('/health', (req, res) => res.json({ ok: true, running: SIM.running }));

app.post('/model', async (req, res) => {
  // POST a city model array [{name,lat,lng,weight,sigmaKm},...]
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'body must be array' });
  CITY_MODEL = req.body.filter(x => typeof x.lat === 'number' && typeof x.lng === 'number' && x.name);
  res.json({ loaded: CITY_MODEL.length });
});

app.post('/start', async (req, res) => {
  const { mode, eventsPerSec, batchSize, spread, seed, concurrency } = req.body || {};
  if (mode) SIM.mode = mode;
  if (eventsPerSec) SIM.eventsPerSec = Math.max(1, Number(eventsPerSec));
  if (batchSize) SIM.batchSize = Math.max(1, Number(batchSize));
  if (spread != null) SIM.spread = Math.max(0.1, Number(spread));
  if (concurrency) SIM.concurrency = Math.max(1, Math.floor(Number(concurrency)));
  SIM.seed = (seed === null || seed === undefined || seed === '') ? null : Number(seed);

  if (SIM.running && SIM.timer) clearInterval(SIM.timer);

  // Precompute per-worker EPS split (distribute remainder fairly)
  const base = Math.floor(SIM.eventsPerSec / SIM.concurrency);
  const extra = SIM.eventsPerSec % SIM.concurrency;

    SIM.timer = setInterval(() => {
    // distribute EPS across workers
    for (let w = 0; w < SIM.concurrency; w++) {
        const epsForThisWorker = base + (w < extra ? 1 : 0);
        if (epsForThisWorker > 0) tick(epsForThisWorker);
    }

    // ---- throughput roll-up (once per second) ----
    STATS.history.push(STATS.lastSecondInserts);
    if (STATS.history.length > STATS.maWindow) STATS.history.shift();
    STATS.lastSecondInserts = 0;
    }, 1000);

  SIM.running = true;
  res.json({ running: true, ...serializeSim(), cityModelSize: CITY_MODEL.length });
});


app.post('/stop', async (req, res) => {
  if (SIM.timer) clearInterval(SIM.timer);
  SIM.timer = null;
  SIM.running = false;
  //res.json({ running: false });
  res.json({ running: false, ...serializeSim(), cityModelSize: CITY_MODEL.length });

});

app.get('/status', (req, res) => {
  // res.json({ running: SIM.running, ...SIM, cityModelSize: CITY_MODEL.length });
  // res.json({ running: SIM.running, ...serializeSim(), cityModelSize: CITY_MODEL.length });
  res.json({running: SIM.running,
        ...serializeSim(),
        cityModelSize: CITY_MODEL.length,
        insertsPerSecMA: movingAverage(),    // <- moving average inserts/sec
        insertsPerSecWindow: STATS.maWindow  // seconds used for MA
    });
});

app.listen(PORT, () => {
  console.log(`Simulator server listening on http://localhost:${PORT}`);
});
