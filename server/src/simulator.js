// server/simulator.js
import fs from 'fs/promises';
import path from 'path';
import { CONFIG, buildSimRunId } from './config.js';
import { connectDB, insertSimRun, endSimRun } from './db.js';
import { loadCityModel, pickCity, jitterPoint } from './cityModel.js';
import { makeRNG } from './rng.js';
import { makeServiceIssue, initServiceIssueRun, cleanupServiceIssueRun } from './serviceIssues.js';
import { SEVERITY_MAP } from './typeSpecs.js';
import { getRunState, setCurrentSimRun, clearCurrentSimRun } from './runState.js';
import { repairScheduler } from './repairScheduler.js';
import { injectScenarios, listScenarios } from './scenarioRunner.js';

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
    scenariosEnabled: false, // inject scripted scenarios
    scenarios: [],           // list of scenario IDs to inject
    // Repeatable mode
    genMode: 'continuous',   // 'continuous' | 'repeatable'
    datasetName: null,
    repeatableCount: 1000,
    outputMode: 'both',      // 'atlas' | 'json' | 'both'
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
  // Repeatable mode progress
  repeatableProgress: null, // { current: 0, total: 1000, outputMode: 'both' }
};

export function getStatus() {
  const { eventsPerSec, batchSize, spread, seed, concurrency, genMode } = SIM.params;
  const insertsPerSecMA = movingAverage(SIM.stats.history, SIM.stats.insertsPerSecWindow);
  const run = getRunState();
  return {
    running: SIM.running,
    eventsPerSec, batchSize, spread, seed, concurrency,
    genMode,
    cityModelSize: SIM.stats.cityModelSize,
    insertsPerSecMA,
    insertsPerSecWindow: SIM.stats.insertsPerSecWindow,
    activeWorkers: SIM.stats.activeWorkers,
    repairsEnabled: !!SIM.params.repairsEnabled, // echo for UI
    simRunId: run.simRunId,
    runStartedAt: run.startedAt,
    runParams: run.params,
    repeatableProgress: SIM.repeatableProgress,
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
  p.scenariosEnabled = !!input?.scenariosEnabled;
  p.scenarios = Array.isArray(input?.scenarios)
    ? input.scenarios.filter(s => typeof s === 'string')
    : (p.scenariosEnabled ? listScenarios() : []); // default: all scenarios if enabled

  // Repeatable mode params
  p.genMode = input?.genMode === 'repeatable' ? 'repeatable' : 'continuous';
  p.datasetName = typeof input?.datasetName === 'string' ? input.datasetName.trim() : 'demo-v1';
  p.repeatableCount = Math.max(1, Math.min(100000, Number(input?.repeatableCount) || 1000));
  p.outputMode = ['atlas', 'json', 'both'].includes(input?.outputMode) ? input.outputMode : 'both';

  // Use datasetName as seed for repeatable mode
  if (p.genMode === 'repeatable' && !p.seed) {
    p.seed = hashString(p.datasetName);
  }

  SIM.params = p;
  SIM.repeatableProgress = null;

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
    scenariosEnabled: p.scenariosEnabled ?? false,
    scenarios: p.scenarios ?? [],
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
    scenariosEnabled: p.scenariosEnabled ?? false,
    scenarios: p.scenarios ?? [],
  });

  // Initialize service issue tracking for this run
  initServiceIssueRun(simRunId);

  // Inject scenarios if enabled
  if (p.scenariosEnabled && p.scenarios.length > 0) {
    try {
      const scenarioResult = await injectScenarios(coll, p.scenarios, simRunId, new Date());
      console.log('[simulator] scenarios injected:', scenarioResult);
    } catch (err) {
      console.error('[simulator] scenario injection failed:', err?.message || err);
    }
  }

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

  SIM.running = true;
  SIM.stats.history = [];
  SIM.stats.lastTickInserted = 0;
  SIM.workers = [];
  SIM.stats.activeWorkers = 0;

  const { rand, gaussian } = makeRNG(p.seed);

  // Repeatable mode: generate fixed count and stop
  if (p.genMode === 'repeatable') {
    SIM.repeatableProgress = {
      current: 0,
      total: p.repeatableCount,
      outputMode: p.outputMode,
      datasetName: p.datasetName,
    };

    const cancel = runRepeatableWorker({
      count: p.repeatableCount,
      batchSize: p.batchSize,
      spread: p.spread,
      rand,
      gaussian,
      coll,
      simRunId: runId,
      outputMode: p.outputMode,
      datasetName: p.datasetName,
    });
    SIM.workers.push(cancel);
    return getStatus();
  }

  // Continuous mode: spin up workers as before
  const base = Math.floor(p.eventsPerSec / p.concurrency);
  const remainder = p.eventsPerSec % p.concurrency;

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

    // Clean up service issue tracking for this run
    cleanupServiceIssueRun(simRunId);
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
            const serviceIssue = makeServiceIssue(rand, c.name, { simRunId });

            // Derive weight and sigmaKm from severity instead of city
            const severityMeta = SEVERITY_MAP[serviceIssue.severity] ?? { weight: 2, sigmaKm: 5 };

            docs[i] = {
              type: 'incident',
              ts: new Date(),
              loc: { type: 'Point', coordinates: [p.lng, p.lat] },
              city: c.name,
              state: c.state,
              lat: p.lat,
              lng: p.lng,
              weight: severityMeta.weight,
              sigmaKm: severityMeta.sigmaKm,
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

/** Simple string hash for deterministic seed from dataset name */
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/** Output directory for repeatable JSON datasets */
const REPEATABLE_OUTPUT_DIR = path.join(process.cwd(), 'data', 'generated-incidents');

/** Write incidents to JSON files */
async function writeRepeatableJson(datasetName, incidents) {
  const outputDir = path.join(REPEATABLE_OUTPUT_DIR, datasetName);
  await fs.mkdir(outputDir, { recursive: true });

  // Group by category
  const byCategory = {};
  for (const inc of incidents) {
    const cat = inc.serviceIssue?.category || 'unknown';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(inc);
  }

  // Write category files
  for (const [cat, docs] of Object.entries(byCategory)) {
    const catDir = path.join(outputDir, cat);
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'incidents.json'),
      JSON.stringify(docs, null, 2)
    );
  }

  // Write combined file
  await fs.writeFile(
    path.join(outputDir, 'all-incidents.json'),
    JSON.stringify(incidents, null, 2)
  );

  // Write manifest
  const manifest = {
    datasetName,
    generatedAt: new Date().toISOString(),
    totalCount: incidents.length,
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [k, v.length])
    ),
  };
  await fs.writeFile(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`[simulator] Wrote ${incidents.length} incidents to ${outputDir}`);
  return outputDir;
}

/** Repeatable mode worker: generates fixed count of incidents, then stops */
function runRepeatableWorker({ count, batchSize, spread, rand, gaussian, coll, simRunId, outputMode, datasetName }) {
  if (!simRunId) console.error('[simulator] runRepeatableWorker started without simRunId');
  let alive = true;
  SIM.stats.activeWorkers += 1;

  const allIncidents = []; // collect for JSON output

  const tick = async () => {
    try {
      let generated = 0;

      while (SIM.running && alive && generated < count) {
        const start = Date.now();
        const remaining = count - generated;
        const thisBatch = Math.min(batchSize, remaining);
        const docs = new Array(thisBatch);

        for (let i = 0; i < thisBatch; i++) {
          const c = pickCity(SIM.model, rand);
          const p = jitterPoint(c, spread, gaussian);
          const serviceIssue = makeServiceIssue(rand, c.name, { simRunId });
          const severityMeta = SEVERITY_MAP[serviceIssue.severity] ?? { weight: 2, sigmaKm: 5 };

          docs[i] = {
            type: 'incident',
            ts: new Date(),
            loc: { type: 'Point', coordinates: [p.lng, p.lat] },
            city: c.name,
            state: c.state,
            lat: p.lat,
            lng: p.lng,
            weight: severityMeta.weight,
            sigmaKm: severityMeta.sigmaKm,
            serviceIssue,
            simRunId,
          };
        }

        // Insert to Atlas if outputMode includes it
        if (outputMode === 'atlas' || outputMode === 'both') {
          try {
            const res = await coll.insertMany(docs, { ordered: false });
            SIM.stats.history.push(res.insertedCount ?? docs.length);
          } catch {
            SIM.stats.history.push(docs.length);
          }
        }

        // Collect for JSON output
        if (outputMode === 'json' || outputMode === 'both') {
          allIncidents.push(...docs);
        }

        generated += thisBatch;

        // Update progress
        SIM.repeatableProgress = {
          ...SIM.repeatableProgress,
          current: generated,
        };

        if (SIM.stats.history.length > 300) {
          SIM.stats.history.splice(0, SIM.stats.history.length - 300);
        }

        // Small delay to prevent blocking (but much faster than continuous mode)
        const elapsed = Date.now() - start;
        if (elapsed < 50) await sleep(50 - elapsed);
      }

      // Write JSON output if requested
      if ((outputMode === 'json' || outputMode === 'both') && allIncidents.length > 0) {
        try {
          await writeRepeatableJson(datasetName, allIncidents);
        } catch (err) {
          console.error('[simulator] Failed to write JSON output:', err?.message || err);
        }
      }

      console.log(`[simulator] Repeatable mode complete: ${generated} incidents generated`);

      // Auto-stop the simulator
      SIM.repeatableProgress = {
        ...SIM.repeatableProgress,
        current: generated,
        complete: true,
      };

    } finally {
      SIM.stats.activeWorkers = Math.max(0, SIM.stats.activeWorkers - 1);
      // Trigger graceful stop
      if (SIM.running) {
        stopSimulator().catch(err => {
          console.error('[simulator] Auto-stop failed:', err?.message || err);
        });
      }
    }
  };

  tick();
  return () => { alive = false; };
}
