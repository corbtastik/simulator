// server/runState.js
// Single-process in-memory run state. No DB calls here.

const runState = {
  simRunId: null,
  startedAt: null,
  params: null,
};

export function getCurrentSimRunId() {
  return runState.simRunId;
}

export function setCurrentSimRun(simRunId, params) {
  runState.simRunId = simRunId;
  runState.startedAt = new Date();
  runState.params = params || null;
}

export function clearCurrentSimRun() {
  runState.simRunId = null;
  runState.startedAt = null;
  runState.params = null;
}

export function getRunState() {
  // return a shallow copy so callers can’t mutate internal state
  return { ...runState };
}
