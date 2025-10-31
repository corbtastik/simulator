// server/simulator.js
import { CONFIG, buildSimRunId } from './config.js';
import { connectDB, insertSimRun, endSimRun } from './db.js';
import { loadCityModel, pickCity, jitterPoint } from './cityModel.js';
import { makeRNG } from './rng.js';
import { makeServiceIssue } from './serviceIssues.js';
import { getRunState, setCurrentSimRun, clearCurrentSimRun } from './runState.js';
import { repairScheduler } from './repairScheduler.js';

const SIM = {
  running: false,
  params: {
    eventsPerSec: 8000,
    batchSize: 1000,
    spread: 2,
    seed: null,
    concurrency: 1,
    note: null,
    repairsEnabled: false,   // single toggle
  },
  workers: [],
  stats: {
    cityModelSize: 0,
    insertsPerSecWindow: CONFIG.STATUS_WINDOW_SEC,
    history: [],
    lastTickInserted: 0,
    activeWorkers: 0,
  },
  model: null,
};

export function getStatus() {
  const { eventsPerSec, batchSize, spread, seed, concurrency } = SIM.params;
  const insertsPerSecMA = movingAverage(SIM.stats.history, SIM.stats.insertsPerSecWindow);
  const run = getRunState();
  return {
    running: SIM.running,
    eventsPerSec, batchSize, spread, seed, concurrency,
    cityModelSize: SIM.stats.cityModelSize,
    insertsPerSecMA,
    insertsPerSecWindow: SIM.stats.insertsPerSecWindow,
    activeWorkers: SIM.stats.activeWorkers,
    repairsEnabled: !!SIM.params.repairsEnabled, // echo for UI
    simRunId: run.simRunId,
    runStartedAt: run.startedAt,
    runParams: run.params,
  };
}

export async function initSimulator() {
  const { coll } = await connectDB();
  SIM.model = loadCityModel(CONFIG.CITY_JSON_PATH);
  SIM.stats.cityModelSize = SIM.model.cities.length;
  await coll.estimatedDocumentCount().catch(() => {});
}

export async function startSimulator(input) {
  if (SIM.running) return getStatus();

  // Validate & carry-through
  const p = validateParams(input);
  p.note = typeof input?.note === 'string' ? input.note : null;
  p.repairsEnabled = !!input?.repairsEnabled;
  SIM.params = p;

  const { db, coll } = await connectDB();

  const simRunId = buildSimRunId(p.seed);
  console.log('[after buildSimRunId]', { simRunId, seed: p.seed, repairsEnabled: p.repairsEnabled });
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
    notes: p.note ?? null,
    repairsEnabled: p.repairsEnabled ?? false,
    repairPlan: { version: '2.0.0-phase2' },
  });

  setCurrentSimRun(simRunId, {
    epsTarget: p.eventsPerSec,
    batchSize: p.batchSize,
    spread: p.spread,
    seed: p.seed,
    concurrency: p.concurrency,
    cityModelSize: SIM.stats.cityModelSize,
    note: p.note ?? null,
    repairsEnabled: p.repairsEnabled ?? false,
  });

  // Start the repair scheduler if enabled (it always persists internally)
  try {
    if (p.repairsEnabled) {
      console.log('[before repairScheduler.start(...)]', { simRunId, seed: p.seed, repairsEnabled: p.repairsEnabled });
      repairScheduler.start({ simRunId, params: { seed: p.seed } }, {
        // For dev speed, you can override delays here (commented by default)
        // delayMedianSec: 60,
        // delayP95Sec: 300,
        // maxDelaySec: 1800,
      });
    }
  } catch (e) {
    console.error('[simulator] repairScheduler.start failed:', e?.message || e);
  }

  // spin up workers
  const base = Math.floor(p.eventsPerSec / p.concurrency);
  const remainder = p.eventsPerSec % p.concurrency;

  SIM.running = true;
  SIM.stats.history = [];
  SIM.stats.lastTickInserted = 0;
  SIM.workers = [];
  SIM.stats.activeWorkers = 0;

  const { rand, gaussian } = makeRNG(p.seed);

  for (let i = 0; i < p.concurrency; i++) {
    const targetEps = base + (i < remainder ? 1 : 0);
    const cancel = runWorker({
      eps: targetEps, batchSize: p.batchSize, spread: p.spread,
      rand, gaussian, coll, simRunId: runId,
    });
    SIM.workers.push(cancel);
  }
  return getStatus();
}

export async function stopSimulator() {
  const { simRunId } = getRunState();

  if (!SIM.running && SIM.stats.activeWorkers === 0) {
    try { await repairScheduler.stop(); } catch {}
    return getStatus();
  }

  SIM.running = false;

  try {
    for (const cancel of SIM.workers) { try { cancel?.(); } catch {} }
  } finally {
    SIM.workers = [];
  }

  try { await repairScheduler.stop(); } catch (e) {
    console.error('[simulator] repairScheduler.stop failed:', e?.message || e);
  }

  const GUARD_MS = Number(CONFIG?.STOP_GUARD_MS ?? 2000);
  const POLL_MS = 25;
  const startWait = Date.now();
  while (SIM.stats.activeWorkers > 0 && (Date.now() - startWait) < GUARD_MS) {
    await sleep(POLL_MS);
  }

  if (simRunId) {
    const { db } = await connectDB();
    try { await endSimRun(db, simRunId); }
    catch (err) { console.error('[simulator] endSimRun failed:', err?.message || err); }
  }

  clearCurrentSimRun();

  const insertsPerSecMA = movingAverage(SIM.stats.history, SIM.stats.insertsPerSecWindow);
  console.log('[simulator] run-closed', {
    simRunId, activeWorkers: SIM.stats.activeWorkers,
    insertsPerSecMA, guardUsedMs: Date.now() - startWait,
  });

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
  if (!simRunId) console.error('[simulator] runWorker started without simRunId');
  let alive = true;
  SIM.stats.activeWorkers += 1;

  const tick = async () => {
    try {
      while (SIM.running && alive) {
        const start = Date.now();
        const batches = Math.max(1, Math.ceil(eps / batchSize));
        let insertedThisTick = 0;

        for (let b = 0; b < batches; b++) {
          const size = Math.min(batchSize, eps - b * batchSize) || batchSize;
          const docs = new Array(size);

          for (let i = 0; i < size; i++) {
            const c = pickCity(SIM.model, rand);
            const p = jitterPoint(c, spread, gaussian);
            const serviceIssue = makeServiceIssue(rand, c.name);

            docs[i] = {
              type: 'incident',
              ts: new Date(),
              loc: { type: 'Point', coordinates: [p.lng, p.lat] },
              city: c.name,
              lat: p.lat,
              lng: p.lng,
              weight: c.weight,
              sigmaKm: c.sigmaKm,
              serviceIssue,
              simRunId,
            };
          }

          try {
            if (!simRunId) { console.error('[simulator] Missing simRunId; cancelling worker tick.'); alive = false; break; }
            const res = await coll.insertMany(docs, { ordered: false });
            insertedThisTick += res.insertedCount ?? docs.length;
          } catch {
            insertedThisTick += docs.length;
          }
        }

        SIM.stats.history.push(insertedThisTick);
        if (SIM.stats.history.length > 300) SIM.stats.history.splice(0, SIM.stats.history.length - 300);

        const elapsed = Date.now() - start;
        const sleepMs = Math.max(0, 1000 - elapsed);
        await sleep(sleepMs);
      }
    } finally {
      SIM.stats.activeWorkers = Math.max(0, SIM.stats.activeWorkers - 1);
    }
  };

  tick();
  return () => { alive = false; };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
