// server/src/serviceIssues.js
// Rich serviceIssue generator using type specs with narrative diversity.

import {
  TYPE_SPECS,
  ALL_TYPES,
  SEVERITY_MAP,
  SEVERITIES,
  SEVERITY_WEIGHTS,
  REPORTED_BY,
  REPORTED_BY_WEIGHTS,
  IMPACT_SCOPES,
} from './typeSpecs.js';

// --- helpers ---
function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

function weightedPick(arr, weights, rand) {
  const r = rand();
  let cumulative = 0;
  for (let i = 0; i < arr.length; i++) {
    cumulative += weights[i];
    if (r < cumulative) return arr[i];
  }
  return arr[arr.length - 1];
}

function rint(rand, lo, hi) {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}

function rfloat(rand, lo, hi, dp = 1) {
  return Number((rand() * (hi - lo) + lo).toFixed(dp));
}

// --- Phrasing tracker for distribution caps ---
// Tracks usage per type per simRunId to enforce:
// - No single phrasing > 20% of that type's narratives
// - "backhoe" capped at ~8% of fiber narratives
class PhrasingTracker {
  constructor() {
    // Map<simRunId, Map<type, Map<phrasing, count>>>
    this.runs = new Map();
    // Map<simRunId, Map<type, totalCount>>
    this.totals = new Map();
  }

  reset(simRunId) {
    this.runs.set(simRunId, new Map());
    this.totals.set(simRunId, new Map());
  }

  getUsage(simRunId, type) {
    if (!this.runs.has(simRunId)) {
      this.runs.set(simRunId, new Map());
      this.totals.set(simRunId, new Map());
    }
    const runMap = this.runs.get(simRunId);
    if (!runMap.has(type)) {
      runMap.set(type, new Map());
    }
    return runMap.get(type);
  }

  getTotal(simRunId, type) {
    if (!this.totals.has(simRunId)) {
      this.totals.set(simRunId, new Map());
    }
    return this.totals.get(simRunId).get(type) ?? 0;
  }

  increment(simRunId, type, phrasing) {
    const usage = this.getUsage(simRunId, type);
    usage.set(phrasing, (usage.get(phrasing) ?? 0) + 1);

    const totals = this.totals.get(simRunId);
    totals.set(type, (totals.get(type) ?? 0) + 1);
  }

  choosePhrasing(simRunId, type, rand) {
    const spec = TYPE_SPECS[type];
    const pool = spec.phrasings;
    const usage = this.getUsage(simRunId, type);
    const total = this.getTotal(simRunId, type) + 1; // +1 for the one we're about to add

    // Calculate caps
    const generalCap = Math.max(1, Math.ceil(total * 0.20));
    const backhoeCap = Math.max(1, Math.ceil(total * 0.08));

    // Filter to candidates under cap
    const candidates = pool.filter((p) => {
      const count = usage.get(p) ?? 0;
      const isBackhoe = /backhoe/i.test(p);
      const cap = isBackhoe ? backhoeCap : generalCap;
      return count < cap;
    });

    // Pick from candidates, or fall back to full pool if all at cap
    const chosen = candidates.length > 0
      ? candidates[Math.floor(rand() * candidates.length)]
      : pool[Math.floor(rand() * pool.length)];

    this.increment(simRunId, type, chosen);
    return chosen;
  }

  // Clean up old runs to prevent memory leak
  cleanup(simRunId) {
    this.runs.delete(simRunId);
    this.totals.delete(simRunId);
  }
}

// Global tracker instance
const phrasingTracker = new PhrasingTracker();

// --- Ticket reference generator ---
let ticketCounter = 1000;
const ticketYear = new Date().getFullYear();

function generateTicketRef(rand) {
  // Use a combination of counter and randomness for uniqueness
  const seq = ticketCounter++;
  const suffix = rint(rand, 0, 99);
  return `INC-${ticketYear}-${String(seq).padStart(4, '0')}${suffix > 0 ? String(suffix).padStart(2, '0') : ''}`;
}

// Reset ticket counter for new run
export function resetTicketCounter(startValue = 1000) {
  ticketCounter = startValue;
}

// --- Main generator ---

/**
 * Create a rich serviceIssue object.
 * @param {Function} rand - PRNG returning [0,1)
 * @param {string} city - City name (unused in new impl but kept for API compat)
 * @param {object} options - Additional options
 * @param {string} options.simRunId - Run identifier for phrasing tracking
 * @param {string} options.type - Force a specific service type (optional)
 * @returns {object} - Full serviceIssue object
 */
export function makeServiceIssue(rand, city, options = {}) {
  const simRunId = options.simRunId ?? 'default';

  // Select type (random or forced)
  const type = options.type ?? pick(ALL_TYPES, rand);
  const spec = TYPE_SPECS[type];

  if (!spec) {
    console.error(`[serviceIssues] Unknown type: ${type}`);
    return { type: 'unknown', category: 'unknown', issue: 'unspecified' };
  }

  // Helper for this rand instance
  const pickArr = (arr) => pick(arr, rand);

  // Generate type-specific fields
  const fields = spec.fields(rand, pickArr);

  // Choose phrasing with caps enforcement
  const phrasing = phrasingTracker.choosePhrasing(simRunId, type, rand);

  // Generate impact
  const impactCount = rint(rand, spec.impactRange[0], spec.impactRange[1]);
  const impact = {
    unit: spec.impactUnit,
    count: impactCount,
    scope: pickArr(IMPACT_SCOPES),
  };

  // Generate narrative from template
  const narrative = spec.template(fields, phrasing, impactCount);

  // Generate severity and related fields
  const severity = weightedPick(SEVERITIES, SEVERITY_WEIGHTS, rand);
  const reportedBy = weightedPick(REPORTED_BY, REPORTED_BY_WEIGHTS, rand);

  // Generate resolution skeleton (open on insert)
  const resolution = {
    state: 'open',
    rootCause: null,
    hours: null,
    crew: spec.crew,
    techs: rint(rand, 1, 4),
    truckRolls: rint(rand, 0, 2),
    parts: spec.parts,
    costUsd: null,
    resolvedAt: null,
    resolutionNotes: null,
  };

  return {
    type,
    category: spec.category,
    issue: spec.issue,
    ticketRef: generateTicketRef(rand),
    narrative,
    symptoms: spec.symptoms,
    severity,
    reportedBy,
    impact,
    ...fields,
    resolution,
  };
}

/**
 * Create a resolved serviceIssue for prediction corpus.
 * @param {Function} rand - PRNG returning [0,1)
 * @param {string} city - City name
 * @param {object} options - Options including simRunId
 * @returns {object} - Full serviceIssue with resolution populated
 */
export function makeResolvedServiceIssue(rand, city, options = {}) {
  const issue = makeServiceIssue(rand, city, options);
  const spec = TYPE_SPECS[issue.type];

  // Populate resolution fields
  const hours = rfloat(rand, 1.2, 9.5, 1);
  const costMultiplier = 0.7 + rand() * 0.8;

  issue.resolution = {
    state: 'resolved',
    rootCause: spec.digRelated ? 'third-party-dig' : pick(['equipment-fault', 'config-error', 'capacity'], rand),
    hours,
    crew: spec.crew,
    techs: rint(rand, 1, 4),
    truckRolls: rint(rand, 0, 2),
    parts: spec.parts,
    costUsd: Math.round(spec.costBase * costMultiplier),
    resolvedAt: new Date(Date.now() - rint(rand, 60, 10080) * 60000).toISOString(), // 1 min to 7 days ago
    resolutionNotes: pick([
      'Root cause identified and corrected.',
      'Equipment replaced, service restored.',
      'Configuration updated, monitoring.',
      'Temporary fix in place, permanent scheduled.',
    ], rand),
  };

  return issue;
}

// --- Run lifecycle ---

/**
 * Initialize tracking for a new simulation run.
 * Call this at run start.
 */
export function initServiceIssueRun(simRunId) {
  phrasingTracker.reset(simRunId);
  resetTicketCounter(rint(() => Math.random(), 1000, 5000));
}

/**
 * Clean up tracking for a completed run.
 * Call this at run end.
 */
export function cleanupServiceIssueRun(simRunId) {
  phrasingTracker.cleanup(simRunId);
}

// Export for testing
export { phrasingTracker, TYPE_SPECS, ALL_TYPES };
