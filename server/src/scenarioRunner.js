// server/src/scenarioRunner.js
// Loads and injects deterministic scenario incidents at run start.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TYPE_SPECS, SEVERITY_MAP } from './typeSpecs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCENARIOS_DIR = path.join(__dirname, '../data/scenarios');

// Available scenarios
const SCENARIO_FILES = {
  'warrior-cascade': 'warrior-cascade.json',
  'lexical-edge': 'lexical-edge.json',
  'novel': 'novel.json',
};

/**
 * Load a scenario definition from disk.
 * @param {string} scenarioId - Scenario identifier
 * @returns {object|null} - Scenario definition or null if not found
 */
export function loadScenario(scenarioId) {
  const filename = SCENARIO_FILES[scenarioId];
  if (!filename) {
    console.warn(`[scenarioRunner] Unknown scenario: ${scenarioId}`);
    return null;
  }

  const filepath = path.join(SCENARIOS_DIR, filename);
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[scenarioRunner] Failed to load scenario ${scenarioId}:`, err.message);
    return null;
  }
}

/**
 * Build incident documents from a scenario definition.
 * @param {object} scenario - Scenario definition
 * @param {string} simRunId - Simulation run ID
 * @param {Date} baseTs - Base timestamp for the scenario
 * @returns {object[]} - Array of incident documents ready for insert
 */
export function buildScenarioDocuments(scenario, simRunId, baseTs = new Date()) {
  const docs = [];
  const baseTime = baseTs.getTime();

  // Process main incidents
  if (scenario.incidents) {
    for (const inc of scenario.incidents) {
      const doc = buildIncidentDocument(inc, scenario, simRunId, baseTime);
      if (doc) docs.push(doc);
    }
  }

  // Process control case (if present)
  if (scenario.control) {
    const doc = buildIncidentDocument(scenario.control, scenario, simRunId, baseTime);
    if (doc) {
      doc.scenario = { isControl: true };
      docs.push(doc);
    }
  }

  return docs;
}

/**
 * Build a single incident document from scenario incident definition.
 */
function buildIncidentDocument(inc, scenario, simRunId, baseTime) {
  const spec = TYPE_SPECS[inc.type];
  if (!spec) {
    console.warn(`[scenarioRunner] Unknown type in scenario: ${inc.type}`);
    return null;
  }

  // Calculate timestamp
  const ts = new Date(baseTime + (inc.tOffsetMin ?? 0) * 60000);

  // Calculate coordinates
  let lat, lng, city, state;
  if (scenario.baseLat !== undefined) {
    // Cluster-style: jitter from base location
    lat = scenario.baseLat + (inc.latJitter ?? 0);
    lng = scenario.baseLng + (inc.lngJitter ?? 0);
    city = scenario.baseCity;
    state = scenario.baseState;
  } else {
    // Individual location
    lat = inc.lat;
    lng = inc.lng;
    city = inc.city;
    state = inc.state;
  }

  // Get severity meta
  const severityMeta = SEVERITY_MAP[inc.severity] ?? { weight: 2, sigmaKm: 5 };

  // Build serviceIssue
  const serviceIssue = {
    type: inc.type,
    category: spec.category,
    issue: spec.issue,
    ticketRef: inc.ticketRef,
    narrative: inc.narrative,
    symptoms: spec.symptoms,
    severity: inc.severity,
    reportedBy: inc.reportedBy,
    impact: inc.impact,
    ...inc.fields,
    resolution: {
      state: 'open',
      rootCause: null,
      hours: null,
      crew: spec.crew,
      techs: Math.floor(Math.random() * 4) + 1,
      truckRolls: Math.floor(Math.random() * 3),
      parts: spec.parts,
      costUsd: null,
      resolvedAt: null,
      resolutionNotes: null,
    },
  };

  // Build full document
  const doc = {
    type: 'incident',
    ts,
    loc: { type: 'Point', coordinates: [lng, lat] },
    city,
    state,
    lat,
    lng,
    weight: severityMeta.weight,
    sigmaKm: severityMeta.sigmaKm,
    serviceIssue,
    simRunId,
    scenario: {
      id: scenario.id,
      isSeed: inc.isSeed ?? false,
    },
  };

  // Add cluster info if present
  if (scenario.clusterId) {
    doc.correlation = {
      clusterId: scenario.clusterId,
      isSystemic: true,
      isSeed: inc.isSeed ?? false,
      novelty: null,
    };
  }

  // Add novelty if present
  if (inc.novelty !== undefined) {
    doc.correlation = doc.correlation ?? {};
    doc.correlation.novelty = inc.novelty;
  }

  return doc;
}

/**
 * Inject scenario documents into the database.
 * @param {Collection} coll - MongoDB collection
 * @param {string[]} scenarioIds - List of scenario IDs to inject
 * @param {string} simRunId - Simulation run ID
 * @param {Date} baseTs - Base timestamp
 * @returns {Promise<object>} - Summary of injected documents
 */
export async function injectScenarios(coll, scenarioIds, simRunId, baseTs = new Date()) {
  const results = {
    requested: scenarioIds,
    injected: [],
    failed: [],
    totalDocs: 0,
  };

  for (const scenarioId of scenarioIds) {
    const scenario = loadScenario(scenarioId);
    if (!scenario) {
      results.failed.push({ id: scenarioId, reason: 'not found' });
      continue;
    }

    const docs = buildScenarioDocuments(scenario, simRunId, baseTs);
    if (docs.length === 0) {
      results.failed.push({ id: scenarioId, reason: 'no documents' });
      continue;
    }

    try {
      const res = await coll.insertMany(docs, { ordered: false });
      results.injected.push({
        id: scenarioId,
        count: res.insertedCount ?? docs.length,
        ticketRefs: docs.map(d => d.serviceIssue.ticketRef),
      });
      results.totalDocs += res.insertedCount ?? docs.length;
    } catch (err) {
      results.failed.push({ id: scenarioId, reason: err.message });
    }
  }

  console.log('[scenarioRunner] injection complete:', results);
  return results;
}

/**
 * Get list of available scenario IDs.
 */
export function listScenarios() {
  return Object.keys(SCENARIO_FILES);
}
