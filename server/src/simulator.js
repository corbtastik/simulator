// server/simulator.js
import { CONFIG, /* add export in config.js if not already */ buildSimRunId } from './config.js';
import { connectDB, insertSimRun, endSimRun } from './db.js';
import { loadCityModel, pickCity, jitterPoint } from './cityModel.js';
import { makeRNG } from './rng.js';
import { makeServiceIssue } from './serviceIssues.js';
import { getRunState, setCurrentSimRun, clearCurrentSimRun } from './runState.js';

const SIM = {
  running: false,
  params: {
    eventsPerSec: 8000,
    batchSize: 1000,
    spread: 2,
    seed: null,
    concurrency: 1,
  },
  workers: [], // array of cancel fns
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
  const run = getRunState();
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
    // run metadata (null when no active run)
    simRunId: run.simRunId,
    runStartedAt: run.startedAt,
    runParams: run.params,
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

  const { db, coll } = await connectDB();

  // Build a stable run id and persist the sim_runs record
  const simRunId = buildSimRunId(p.seed);
  // keep a local copy for this run (avoid reading shared state in hot path)
  const runId = simRunId;

  await insertSimRun(db, {
    simRunId,
    startedAt: new Date(),
    endedAt: null,
    seed: p.seed ?? null,
    epsTarget: p.eventsPerSec ?? null,
    batchSize: p.batchSize ?? null,
    spread: p.spread ?? null,
    concurrency: p.concurrency ?? null,
    cityModelSize: SIM.stats.cityModelSize,
    appVersion: process.env.APP_VERSION || null,
    gitSha: process.env.GIT_SHA || null,
    notes: null,
  });

  // Cache run state so workers can stamp docs
  setCurrentSimRun(simRunId, {
    epsTarget: p.eventsPerSec,
    batchSize: p.batchSize,
    spread: p.spread,
    seed: p.seed,
    concurrency: p.concurrency,
    cityModelSize: SIM.stats.cityModelSize,
  });

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
    const cancel = runWorker({
      eps: targetEps,
      batchSize: p.batchSize,
      spread: p.spread,
      rand,
      gaussian,
      coll,
      simRunId: runId,
    });
    SIM.workers.push(cancel);
  }
  return getStatus();
}

export async function stopSimulator() {
  const { simRunId } = getRunState();

  // signal loops to stop
  SIM.running = false;

  // actively cancel each worker so its `alive` flips false promptly
  try {
    for (const cancel of SIM.workers) {
      try { cancel?.(); } catch {}
    }
  } finally {
    SIM.workers = [];
  }

  // mark run ended (non-fatal if this fails)
  if (simRunId) {
    const { db } = await connectDB();
    try {
      await endSimRun(db, simRunId);
    } catch (err) {
      console.error('[simulator] endSimRun failed:', err?.message || err);
    }
  }

  // clear in-memory run state AFTER DB write
  clearCurrentSimRun();

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

function runWorker({ eps, batchSize, spread, rand, gaussian, coll, simRunId }) {
  if (!simRunId) {
    console.error('[simulator] runWorker started without simRunId');
  }
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
          const c = pickCity(SIM.model, rand);                  // weighted by city.weight
          const p = jitterPoint(c, spread, gaussian);           // Gaussian jitter scaled by c.sigmaKm * spread
          const serviceIssue = makeServiceIssue(rand, c.name);  // embedded service issue, uses city for code

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
            // stamp run
            simRunId,
          };
        }

        try {
          if (!simRunId) {
            // soft-cancel this worker if we somehow lost the run id
            console.error('[simulator] Missing simRunId; cancelling worker tick.');
            alive = false;
            break;
          }
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
    // optional: debug log on worker exit
    // console.log('[simulator] worker exit');
  };

  tick(); // fire and forget
  return () => {
    alive = false;
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
