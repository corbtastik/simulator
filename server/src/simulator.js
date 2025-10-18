// server/src/simulator.js
import { CONFIG } from './config.js';
import { connectDB } from './db.js';
import { loadCityModel, pickCity, jitterPoint } from './cityModel.js';
import { makeRNG } from './rng.js';
import { makeServiceIssue } from './serviceIssues.js';

const SIM = {
  running: false,
  params: {
    eventsPerSec: 8000,
    batchSize: 1000,
    spread: 2,
    seed: null,
    concurrency: 1,
  },
  workers: [],
  stats: {
    cityModelSize: 0,
    insertsPerSecWindow: CONFIG.STATUS_WINDOW_SEC,
    history: [], // per-second inserted doc counts (rolling)
    lastTickInserted: 0,
  },
  model: null,
};

export function getStatus() {
  const { eventsPerSec, batchSize, spread, seed, concurrency } = SIM.params;
  const insertsPerSecMA = movingAverage(SIM.stats.history, SIM.stats.insertsPerSecWindow);
  return {
    running: SIM.running,
    eventsPerSec,
    batchSize,
    spread,
    seed,
    concurrency,
    cityModelSize: SIM.stats.cityModelSize,
    insertsPerSecMA,
    insertsPerSecWindow: SIM.stats.insertsPerSecWindow,
  };
}

export async function initSimulator() {
  const { coll } = await connectDB();
  // Load weighted city model once
  SIM.model = loadCityModel(CONFIG.CITY_JSON_PATH);
  SIM.stats.cityModelSize = SIM.model.cities.length;
  // Light warmup so the first /start isn't incurring cold paths
  await coll.estimatedDocumentCount().catch(() => {});
}

export async function startSimulator(input) {
  if (SIM.running) return getStatus();

  // Validate & fix params
  const p = validateParams(input);
  SIM.params = p;

  const { coll } = await connectDB();

  // Split EPS across workers deterministically
  const base = Math.floor(p.eventsPerSec / p.concurrency);
  const remainder = p.eventsPerSec % p.concurrency;

  SIM.running = true;
  SIM.stats.history = [];
  SIM.stats.lastTickInserted = 0;
  SIM.workers = [];

  // One RNG shared across workers keeps determinism for a given seed
  const { rand, gaussian } = makeRNG(p.seed);

  for (let i = 0; i < p.concurrency; i++) {
    const targetEps = base + (i < remainder ? 1 : 0);
    SIM.workers.push(
      runWorker({
        eps: targetEps,
        batchSize: p.batchSize,
        spread: p.spread,
        rand,
        gaussian,
        coll,
      })
    );
  }
  return getStatus();
}

export async function stopSimulator() {
  SIM.running = false;
  // workers are cooperative; they exit their loops after current tick
  SIM.workers = [];
  return getStatus();
}

/* ---------------- internals ---------------- */

function validateParams(body = {}) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const num = (x, d) => {
    const n = Number(x ?? d);
    return Number.isFinite(n) ? n : NaN;
  };

  const eventsPerSec = num(body.eventsPerSec, 8000);
  const batchSize = num(body.batchSize, 1000);
  const spread = num(body.spread, 2);
  const seed = body.seed == null || body.seed === '' ? null : num(body.seed, null);
  const concurrency = num(body.concurrency, 1);

  if (!(eventsPerSec >= 1 && eventsPerSec <= CONFIG.MAX_EPS)) throw bad('eventsPerSec must be 1..MAX_EPS');
  if (!(batchSize >= 1 && batchSize <= CONFIG.MAX_BATCH_SIZE)) throw bad('batchSize must be 1..MAX_BATCH_SIZE');
  if (!(spread >= 0.2 && spread <= 5.0)) throw bad('spread must be 0.2..5.0');
  if (!(concurrency >= 1 && concurrency <= CONFIG.MAX_CONCURRENCY)) throw bad('concurrency must be 1..MAX_CONCURRENCY');
  if (eventsPerSec < concurrency) throw bad('eventsPerSec must be >= concurrency');

  return { eventsPerSec, batchSize, spread, seed, concurrency };
}

function movingAverage(history, windowSec) {
  if (!history.length) return 0;
  const len = Math.min(history.length, windowSec);
  const sum = history.slice(-len).reduce((a, b) => a + b, 0);
  return Math.round(sum / len);
}

function runWorker({ eps, batchSize, spread, rand, gaussian, coll }) {
  let alive = true;

  const tick = async () => {
    while (SIM.running && alive) {
      const start = Date.now();
      const batches = Math.max(1, Math.ceil(eps / batchSize));
      let insertedThisTick = 0;

      for (let b = 0; b < batches; b++) {
        const size = Math.min(batchSize, eps - b * batchSize) || batchSize;
        const docs = new Array(size);

        for (let i = 0; i < size; i++) {
          const c = pickCity(SIM.model, rand);             // weighted by city.weight
          const p = jitterPoint(c, spread, gaussian);      // Gaussian jitter scaled by c.sigmaKm * spread
          const serviceIssue = makeServiceIssue(rand, c.name); // embedded service issue, uses city for code

          // Event document (deck.gl friendly + geo)
          docs[i] = {
            type: 'incident',
            ts: new Date(),
            // geo for geospatial queries
            loc: { type: 'Point', coordinates: [p.lng, p.lat] },
            // flat position fields for deck.gl layers
            city: c.name,
            lat: p.lat,
            lng: p.lng,
            // carry model-driven knobs for visualization
            weight: c.weight,
            sigmaKm: c.sigmaKm,
            // rich embedded serviceIssue
            serviceIssue,
          };
        }

        try {
          const res = await coll.insertMany(docs, { ordered: false });
          insertedThisTick += res.insertedCount ?? docs.length;
        } catch {
          // treat as best-effort; assume all attempted
          insertedThisTick += docs.length;
        }
      }

      SIM.stats.history.push(insertedThisTick);
      if (SIM.stats.history.length > 300) {
        SIM.stats.history.splice(0, SIM.stats.history.length - 300);
      }

      // aim for 1 Hz ticks
      const elapsed = Date.now() - start;
      const sleepMs = Math.max(0, 1000 - elapsed);
      await sleep(sleepMs);
    }
  };

  tick(); // fire and forget
  return () => {
    alive = false;
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
