// server/src/repairScheduler.js
// Repair Scheduler with REALISTIC DELAYS -> writes to fix_events after a delay
//
// API:
//   repairScheduler.start(simRunContext, config?)   // runtime overrides allowed
//   repairScheduler.configure(config?)              // tweak while running
//   repairScheduler.stop()
//   repairScheduler.status()
//
// Precedence of settings (highest → lowest):
//   start()/configure() overrides  >  CONFIG.REPAIR  > internal fallbacks
//
// Notes:
// - Deterministic selection (seeded) for WOULD_FIX preview logs.
// - Schedules delayed inserts into incidents.fix_events with type:"fix".
// - Log-normal delay model + jitter + probability gate.
// - Max delay clamped to avoid Node's 32-bit setTimeout overflow.

import { connectDB, insertFixEvent } from './db.js';
import { CONFIG } from './config.js';
import { makeRNG } from './rng.js';

const CR = (CONFIG && CONFIG.REPAIR) || {};

// Internal fallbacks (only used if not provided by CONFIG.REPAIR or overrides)
const FALLBACKS = {
  cadenceMs: 1000,
  budgetPerTick: 5,
  recentWindowSec: 30,
  delayMedianSec: 300,
  delayP95Sec: 1800,
  delayJitterSec: 10,
  pFixProbability: 0.92,
  maxDelaySec: 2 * 60 * 60, // 2h
  policy: 'infra-first',
  version: '2.0.0-phase2'
};

// Build defaults from CONFIG.REPAIR with fallbacks
const DEFAULTS = {
  cadenceMs:        numOr(CR.cadenceMs,        FALLBACKS.cadenceMs),
  budgetPerTick:    numOr(CR.budgetPerTick,    FALLBACKS.budgetPerTick),
  recentWindowSec:  numOr(CR.recentWindowSec,  FALLBACKS.recentWindowSec),

  delayMedianSec:   numOr(CR.delayMedianSec,   FALLBACKS.delayMedianSec),
  delayP95Sec:      numOr(CR.delayP95Sec,      FALLBACKS.delayP95Sec),
  delayJitterSec:   numOr(CR.delayJitterSec,   FALLBACKS.delayJitterSec),
  pFixProbability:  numOr(CR.pFixProbability,  FALLBACKS.pFixProbability),

  // allow env to override the cap if set
  maxDelaySec:      numOr(process.env.REPAIR_MAX_DELAY_SEC, numOr(CR.maxDelaySec, FALLBACKS.maxDelaySec)),

  policy:           strOr(CR.policy,           FALLBACKS.policy),
  version:          strOr(CR.version,          FALLBACKS.version)
};

function numOr(x, d) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function strOr(x, d) {
  return (typeof x === 'string' && x.length) ? x : d;
}

// Heuristic set for infra detection
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

  delayMedianSec: DEFAULTS.delayMedianSec,
  delayP95Sec: DEFAULTS.delayP95Sec,
  delayJitterSec: DEFAULTS.delayJitterSec,
  pFixProbability: DEFAULTS.pFixProbability,
  maxDelaySec: DEFAULTS.maxDelaySec,

  rngFn: null,

  // loop control
  timer: null,
  ticking: false,

  // metrics
  ticks: 0,
  candidatesEmitted: 0,
  scheduled: 0,
  persisted: 0,
  duplicatesIgnored: 0,
  droppedByProbability: 0,
  lastTickAt: null,

  // active timers
  timersByIncident: new Map(), // key: incidentId -> { t, dueAt }
};

function nowIso() { return new Date().toISOString(); }

function chooseCategoryFrom(issue) {
  const t = issue?.type?.toString().toLowerCase();
  if (t && INFRA_TYPES.has(t)) return 'infrastructure';
  if (t && /cell|tower|fiber|backhaul|datacenter|edge|transport|core/.test(t)) return 'infrastructure';
  return 'infrastructure';
}

async function fetchRecentIncidents(simRunId, limit, recentWindowSec) {
  const { coll } = await connectDB();
  const since = new Date(Date.now() - recentWindowSec * 1000);
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

function* deterministicPicker(rngFn, items) {
  const idx = items.map((_, i) => i);
  for (let i = idx.length - 1; i >= 0; i--) {
    const j = Math.floor(rngFn() * (i + 1));
    const k = idx[j];
    [idx[i], idx[j]] = [idx[j], idx[i]];
    yield items[k];
  }
}

// ---- Delay model ----
function sampleLogNormalSeconds(rngFn, { medianSec, p95Sec }) {
  const m = Math.max(1, medianSec | 0);
  const p95 = Math.max(m + 1, p95Sec | 0);
  const mu = Math.log(m);
  const sigma = (Math.log(p95) - mu) / 1.64485;

  const u1 = Math.max(rngFn(), Number.EPSILON);
  const u2 = Math.max(rngFn(), Number.EPSILON);
  const Z_MAX = 3.5; // clamp extreme tails
  let z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  if (z > Z_MAX) z = Z_MAX;
  if (z < -Z_MAX) z = -Z_MAX;

  const ln = Math.exp(mu + sigma * z);
  return Math.max(1, Math.round(ln));
}

async function insertFixAfterDelay({ incidentId, category, simRunId, reason, policy, version }) {
  try {
    const res = await insertFixEvent(undefined, {
      type: 'fix',
      category,
      simRunId,
      incidentId,
      reason,
      policy,
      version,
      ts: new Date(),
    });
    if (res.duplicate) SCHED.duplicatesIgnored += 1;
    else if (res.inserted) SCHED.persisted += 1;
  } catch (e) {
    console.error('[repair][fix][error]', e?.message || e);
  }
}

function scheduleFixTimer({ incidentId, category, simRunId, reason, policy, version, delayMs }) {
  const k = String(incidentId);
  if (SCHED.timersByIncident.has(k)) return false;

  const dueAt = new Date(Date.now() + delayMs);
  const t = setTimeout(async () => {
    try { await insertFixAfterDelay({ incidentId, category, simRunId, reason, policy, version }); }
    finally { SCHED.timersByIncident.delete(k); }
  }, delayMs);

  SCHED.timersByIncident.set(k, { t, dueAt });
  SCHED.scheduled += 1;
  return true;
}

async function tick() {
  if (SCHED.ticking || SCHED.state !== 'running') return;
  SCHED.ticking = true;

  try {
    const batchHint = SCHED.budgetPerTick * 5;
    const pool = await fetchRecentIncidents(SCHED.simRunId, batchHint, SCHED.recentWindowSec);
    const infraPool = pool.filter((d) => chooseCategoryFrom(d.serviceIssue) === 'infrastructure');

    const picker = deterministicPicker(SCHED.rngFn, infraPool);
    let emitted = 0;

    for (const d of picker) {
      if (emitted >= SCHED.budgetPerTick) break;

      const category = 'infrastructure';
      const deterministicKey = `${SCHED.simRunId}:${category}:${d._id.toString()}:${SCHED.version}`;

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

      console.log('[repair]', JSON.stringify(log));
      SCHED.candidatesEmitted += 1;
      emitted += 1;

      if (SCHED.rngFn() > SCHED.pFixProbability) { SCHED.droppedByProbability += 1; continue; }

      let baseSec = sampleLogNormalSeconds(SCHED.rngFn, {
        medianSec: SCHED.delayMedianSec,
        p95Sec: SCHED.delayP95Sec,
      });
      const jitter = Math.floor((SCHED.rngFn() * 2 - 1) * SCHED.delayJitterSec);
      let delaySec = Math.max(1, baseSec + jitter);

      if (delaySec > SCHED.maxDelaySec) {
        console.warn('[repair] delaySec clamped', { baseSec, jitter, delaySec, max: SCHED.maxDelaySec });
        delaySec = SCHED.maxDelaySec;
      }

      const delayMs = Math.min(delaySec * 1000, 2147483647); // guard int32 ms

      scheduleFixTimer({
        incidentId: d._id,
        category,
        simRunId: SCHED.simRunId,
        reason: log.reason,
        policy: log.policy,
        version: log.version,
        delayMs,
      });
    }

    SCHED.ticks += 1;
    SCHED.lastTickAt = new Date();
  } catch (err) {
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
  for (const { t } of SCHED.timersByIncident.values()) clearTimeout(t);
  SCHED.timersByIncident.clear();
}

export const repairScheduler = {
  start(simRunContext, cfg = {}) {
    if (SCHED.state === 'running' && SCHED.simRunId === simRunContext?.simRunId) return this.status();

    const simRunId = simRunContext?.simRunId;
    const seed = simRunContext?.params?.seed ?? null;
    if (!simRunId) throw Object.assign(new Error('repairScheduler.start: missing simRunId'), { status: 400 });

    // Merge overrides with config-driven defaults
    SCHED.cadenceMs        = pickNum(cfg.cadenceMs,       DEFAULTS.cadenceMs);
    SCHED.budgetPerTick    = pickNum(cfg.budgetPerTick,   DEFAULTS.budgetPerTick);
    SCHED.recentWindowSec  = pickNum(cfg.recentWindowSec, DEFAULTS.recentWindowSec);

    SCHED.delayMedianSec   = pickNum(cfg.delayMedianSec,  DEFAULTS.delayMedianSec);
    SCHED.delayP95Sec      = pickNum(cfg.delayP95Sec,     DEFAULTS.delayP95Sec);
    SCHED.delayJitterSec   = pickNum(cfg.delayJitterSec,  DEFAULTS.delayJitterSec);
    SCHED.pFixProbability  = pickNum(cfg.pFixProbability, DEFAULTS.pFixProbability);
    SCHED.maxDelaySec      = pickNum(cfg.maxDelaySec,     DEFAULTS.maxDelaySec);

    SCHED.policy           = pickStr(cfg.policy,          DEFAULTS.policy);
    SCHED.version          = pickStr(cfg.version,         DEFAULTS.version);

    const finalSeed = Number.isFinite(+seed) ? +seed : 0xC0FFEE;
    const { rand } = makeRNG(finalSeed);

    SCHED.state = 'running';
    SCHED.simRunId = simRunId;
    SCHED.rngFn = rand;
    SCHED.ticks = 0;
    SCHED.candidatesEmitted = 0;
    SCHED.scheduled = 0;
    SCHED.persisted = 0;
    SCHED.duplicatesIgnored = 0;
    SCHED.droppedByProbability = 0;
    SCHED.lastTickAt = null;

    stopLoop();
    startLoop();
    return this.status();
  },

  configure(cfg = {}) {
    if (cfg.cadenceMs != null) {
      SCHED.cadenceMs = Number(cfg.cadenceMs);
      if (SCHED.state === 'running') { stopLoop(); startLoop(); }
    }
    if (cfg.budgetPerTick     != null) SCHED.budgetPerTick    = Number(cfg.budgetPerTick);
    if (cfg.recentWindowSec   != null) SCHED.recentWindowSec  = Number(cfg.recentWindowSec);

    if (cfg.delayMedianSec    != null) SCHED.delayMedianSec   = Number(cfg.delayMedianSec);
    if (cfg.delayP95Sec       != null) SCHED.delayP95Sec      = Number(cfg.delayP95Sec);
    if (cfg.delayJitterSec    != null) SCHED.delayJitterSec   = Number(cfg.delayJitterSec);
    if (cfg.pFixProbability   != null) SCHED.pFixProbability  = Number(cfg.pFixProbability);
    if (cfg.maxDelaySec       != null) SCHED.maxDelaySec      = Number(cfg.maxDelaySec);

    if (cfg.policy            != null) SCHED.policy           = String(cfg.policy);
    if (cfg.version           != null) SCHED.version          = String(cfg.version);

    return this.status();
  },

  async stop() {
    if (SCHED.state === 'idle') return this.status();
    SCHED.state = 'stopping';

    const GUARD_MS = 1000;
    const start = Date.now();
    while (SCHED.ticking && Date.now() - start < GUARD_MS) {
      await new Promise((r) => setTimeout(r, 15));
    }

    stopLoop();

    SCHED.state = 'idle';
    SCHED.simRunId = null;
    SCHED.rngFn = null;

    return this.status();
  },

  status() {
    return {
      state: SCHED.state,
      simRunId: SCHED.simRunId,
      cadenceMs: SCHED.cadenceMs,
      budgetPerTick: SCHED.budgetPerTick,
      policy: SCHED.policy,
      version: SCHED.version,
      recentWindowSec: SCHED.recentWindowSec,

      delayMedianSec: SCHED.delayMedianSec,
      delayP95Sec: SCHED.delayP95Sec,
      delayJitterSec: SCHED.delayJitterSec,
      pFixProbability: SCHED.pFixProbability,
      maxDelaySec: SCHED.maxDelaySec,

      ticks: SCHED.ticks,
      candidatesEmitted: SCHED.candidatesEmitted,
      scheduled: SCHED.scheduled,
      persisted: SCHED.persisted,
      duplicatesIgnored: SCHED.duplicatesIgnored,
      droppedByProbability: SCHED.droppedByProbability,
      activeTimers: SCHED.timersByIncident.size,
      lastTickAt: SCHED.lastTickAt,
    };
  },
};

function pickNum(override, deflt) {
  return (override != null && Number.isFinite(Number(override))) ? Number(override) : deflt;
}
function pickStr(override, deflt) {
  return (typeof override === 'string' && override.length) ? override : deflt;
}
