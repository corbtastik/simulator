// server/src/repairScheduler.js
// Phase-3 Repair Scheduler (preview + optional DB persistence to fix_events)
//
// API:
//   repairScheduler.start(simRunContext, config?)
//   repairScheduler.stop()
//   repairScheduler.status()
//   repairScheduler.configure(config?)  // new (optional): override persist at runtime
//
// Behavior:
// - Deterministic (seeded) selection of recent incidents for WOULD_FIX previews.
// - "infra-first" policy by default; can be extended later.
// - Emits JSON line logs to stdout.
// - (Phase 3) When persistence is enabled, insert a lean document into incidents.fix_events
//   with insert-only semantics (duplicates ignored via unique index).

import { connectDB, insertFixEvent } from './db.js';
import { CONFIG } from './config.js';
import { makeRNG } from './rng.js';

const DEFAULTS = {
  cadenceMs: 1000,           // tick every 1s
  budgetPerTick: 5,          // max candidates to emit per tick
  policy: 'infra-first',     // placeholder for future strategies
  version: '2.0.0-phase2',   // surfaced in logs/status
  recentWindowSec: 30,       // look back this many seconds when choosing candidates
  persist: CONFIG.FIX_PERSIST_DEFAULT === true, // Phase 3: default from env/config
};

// Heuristic set for "infrastructure" types we already use around the project.
// If types differ at runtime, we gracefully fall back to "unknown".
const INFRA_TYPES = new Set([
  'construction', 'smartcell', 'smallcell', 'backhaul',
  'datacenter', 'cloud-network', 'cloud_network', 'edge',
  'tower', 'fiber-plant', 'fiber', 'core', 'transport'
]);

const SCHED = {
  state: 'idle',            // 'idle' | 'running' | 'stopping'
  simRunId: null,
  version: DEFAULTS.version,
  policy: DEFAULTS.policy,
  cadenceMs: DEFAULTS.cadenceMs,
  budgetPerTick: DEFAULTS.budgetPerTick,
  recentWindowSec: DEFAULTS.recentWindowSec,
  persist: DEFAULTS.persist,      // NEW: Phase 3 feature flag

  // deterministic RNG
  rng: null,

  // loop control
  timer: null,
  ticking: false,           // prevents overlapping ticks

  // metrics
  ticks: 0,
  candidatesEmitted: 0,
  persisted: 0,             // NEW: number of rows inserted
  duplicatesIgnored: 0,     // NEW: dup key ignores

  // last snapshot
  lastTickAt: null,
};

function nowIso() {
  return new Date().toISOString();
}

function chooseCategoryFrom(issue) {
  // Phase-3 still infra-only
  const t = issue?.type?.toString().toLowerCase();
  if (t && INFRA_TYPES.has(t)) return 'infrastructure';
  if (t && /cell|tower|fiber|backhaul|datacenter|edge|transport|core/.test(t)) {
    return 'infrastructure';
  }
  return 'infrastructure';
}

async function fetchRecentIncidents(simRunId, limit, recentWindowSec) {
  const { coll } = await connectDB();
  const since = new Date(Date.now() - recentWindowSec * 1000);

  // Pull a small recent set to pick from; requires { ts: 1 } index (already ensured)
  // and benefits from { simRunId: 1, _id: 1 } index (db.ensureSimRunsIndexes).
  const cursor = coll.find(
    { simRunId, ts: { $gte: since } },
    {
      sort: { ts: -1 },
      limit: Math.max(limit, 1),
      projection: { _id: 1, ts: 1, serviceIssue: 1 },
    }
  );

  return cursor.toArray();
}

// Fisher-Yates-style index walk using RNG to select items without replacement
function* deterministicPicker(rngFn, items) {
  const idx = items.map((_, i) => i);
  for (let i = idx.length - 1; i >= 0; i--) {
    const j = Math.floor(rngFn() * (i + 1));
    const k = idx[j];
    [idx[i], idx[j]] = [idx[j], idx[i]];
    yield items[k];
  }
}

async function persistFixCandidate(logLine) {
  // Build the Phase-3 doc shape (lean)
  const doc = {
    simRunId: logLine.simRunId,
    incidentId: logLine.incidentId,
    category: logLine.category,        // "infrastructure"
    action: logLine.action,            // "WOULD_FIX"
    reason: logLine.reason,
    policy: logLine.policy,
    version: logLine.version,
    deterministicKey: logLine.deterministicKey,
    decidedAt: new Date(logLine.ts),   // ISO -> Date
  };

  const res = await insertFixEvent(undefined, doc); // use default DB from connectDB()
  if (res.duplicate) {
    SCHED.duplicatesIgnored += 1;
  } else if (res.inserted) {
    SCHED.persisted += 1;
  }
}

async function tick() {
  if (SCHED.ticking || SCHED.state !== 'running') return;
  SCHED.ticking = true;

  try {
    const batchHint = SCHED.budgetPerTick * 5; // small over-fetch so policy can filter
    const pool = await fetchRecentIncidents(SCHED.simRunId, batchHint, SCHED.recentWindowSec);

    // Filter per policy (infra-first).
    const infraPool = pool.filter((d) => chooseCategoryFrom(d.serviceIssue) === 'infrastructure');

    // Deterministic selection up to budget
    const picker = deterministicPicker(SCHED.rngFn, infraPool);
    let emitted = 0;

    for (const d of picker) {
      if (emitted >= SCHED.budgetPerTick) break;

      const category = 'infrastructure';
      const deterministicKey = `${SCHED.simRunId}:${category}:${d._id.toString()}:${SCHED.version}`;

      // Construct the log payload once so we can both log and persist
      const log = {
        simRunId: SCHED.simRunId,
        ts: nowIso(),
        category,
        incidentId: d._id,
        action: 'WOULD_FIX',
        reason: 'infra-first: recent && sample',
        policy: SCHED.policy,
        version: SCHED.version,
        deterministicKey,
      };

      // Emit JSON line to stdout
      // eslint-disable-next-line no-console
      console.log('[repair]', JSON.stringify(log));

      // Optional DB persistence (Phase 3)
      if (SCHED.persist) {
        try {
          await persistFixCandidate(log);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[repair][persist][error]', e?.message || e);
        }
      }

      emitted += 1;
    }

    SCHED.candidatesEmitted += emitted;
    SCHED.ticks += 1;
    SCHED.lastTickAt = new Date();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[repairScheduler] tick error (continuing):', err?.message || err);
  } finally {
    SCHED.ticking = false;
  }
}

function startLoop() {
  if (SCHED.timer) clearInterval(SCHED.timer);
  SCHED.timer = setInterval(tick, SCHED.cadenceMs);
}

function stopLoop() {
  if (SCHED.timer) {
    clearInterval(SCHED.timer);
    SCHED.timer = null;
  }
}

export const repairScheduler = {
  /**
   * Start the repair scheduler (Phase 3-capable).
   * @param {object} simRunContext - e.g. { simRunId, params: { seed, ... } }
   * @param {object} cfg - optional overrides:
   *   { cadenceMs, budgetPerTick, policy, version, recentWindowSec, persist }
   */
  start(simRunContext, cfg = {}) {
    // Idempotent start
    if (SCHED.state === 'running' && SCHED.simRunId === simRunContext?.simRunId) {
      return this.status();
    }

    const simRunId = simRunContext?.simRunId;
    const seed = simRunContext?.params?.seed ?? null;
    if (!simRunId) {
      throw Object.assign(new Error('repairScheduler.start: missing simRunId'), { status: 400 });
    }

    // Merge config
    SCHED.cadenceMs = Number(cfg.cadenceMs ?? DEFAULTS.cadenceMs);
    SCHED.budgetPerTick = Number(cfg.budgetPerTick ?? DEFAULTS.budgetPerTick);
    SCHED.policy = String(cfg.policy ?? DEFAULTS.policy);
    SCHED.version = String(cfg.version ?? DEFAULTS.version);
    SCHED.recentWindowSec = Number(cfg.recentWindowSec ?? DEFAULTS.recentWindowSec);
    SCHED.persist = typeof cfg.persist === 'boolean' ? cfg.persist : DEFAULTS.persist;

    // Deterministic RNG (derive even when seed is null by using a fixed fallback)
    const finalSeed = Number.isFinite(+seed) ? +seed : 0xC0FFEE;
    const { rand } = makeRNG(finalSeed);

    // Reset state
    SCHED.state = 'running';
    SCHED.simRunId = simRunId;
    SCHED.rngFn = rand;
    SCHED.ticks = 0;
    SCHED.candidatesEmitted = 0;
    SCHED.persisted = 0;
    SCHED.duplicatesIgnored = 0;
    SCHED.lastTickAt = null;

    startLoop();
    return this.status();
  },

  /**
   * Optional runtime configuration update (e.g., flip persistence on/off mid-run).
   * @param {object} cfg - { persist?: boolean, cadenceMs?, budgetPerTick?, recentWindowSec? }
   */
  configure(cfg = {}) {
    if (typeof cfg.persist === 'boolean') SCHED.persist = cfg.persist;
    if (cfg.cadenceMs != null) {
      SCHED.cadenceMs = Number(cfg.cadenceMs);
      // restart loop with new cadence
      if (SCHED.state === 'running') {
        stopLoop();
        startLoop();
      }
    }
    if (cfg.budgetPerTick != null) SCHED.budgetPerTick = Number(cfg.budgetPerTick);
    if (cfg.recentWindowSec != null) SCHED.recentWindowSec = Number(cfg.recentWindowSec);
    return this.status();
  },

  /**
   * Stop the scheduler (idempotent). Waits for an in-flight tick to finish.
   */
  async stop() {
    if (SCHED.state === 'idle') return this.status();
    SCHED.state = 'stopping';

    // Wait briefly if a tick is in progress
    const GUARD_MS = 1000;
    const start = Date.now();
    while (SCHED.ticking && Date.now() - start < GUARD_MS) {
      await new Promise((r) => setTimeout(r, 15));
    }

    stopLoop();

    // Reset lightweight state; keep last metrics for status
    SCHED.state = 'idle';
    SCHED.simRunId = null;
    SCHED.rng = null;

    return this.status();
  },

  /**
   * Current scheduler status snapshot.
   */
  status() {
    return {
      state: SCHED.state,
      simRunId: SCHED.simRunId,
      cadenceMs: SCHED.cadenceMs,
      budgetPerTick: SCHED.budgetPerTick,
      policy: SCHED.policy,
      version: SCHED.version,
      recentWindowSec: SCHED.recentWindowSec,
      persist: SCHED.persist,                 // NEW
      ticks: SCHED.ticks,
      candidatesEmitted: SCHED.candidatesEmitted,
      persisted: SCHED.persisted,             // NEW
      duplicatesIgnored: SCHED.duplicatesIgnored, // NEW
      lastTickAt: SCHED.lastTickAt,
    };
  },
};
