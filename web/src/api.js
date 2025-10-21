// web/src/api.js
const BASE = import.meta.env.VITE_SIM_BASE || 'http://localhost:5050';

async function http(path, { method = 'GET', body, headers, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(id);
  }
}

export async function getStatus() {
  return http('/status');
}

export async function startSim(payload) {
  // payload may include:
  // {
  //   eventsPerSec, batchSize, spread, seed|null, concurrency,
  //   note|null,
  //   repairsEnabled: boolean,
  //   // repairConfig is optional and may include tuning knobs, but NOT 'persist'
  //   // e.g. repairConfig: { cadenceMs?, budgetPerTick?, recentWindowSec?, delayMedianSec?, delayP95Sec?, delayJitterSec?, pFixProbability?, maxDelaySec? }
  // }
  const body = { ...(payload || {}) };

  // Safety: strip deprecated/unsupported 'persist' if a caller still sends it.
  if (body.repairConfig && typeof body.repairConfig === 'object') {
    const { persist, ...rest } = body.repairConfig;
    body.repairConfig = rest;
    if (Object.keys(body.repairConfig).length === 0) {
      delete body.repairConfig;
    }
  }

  return http('/start', { method: 'POST', body });
}

export async function stopSim() {
  return http('/stop', { method: 'POST' });
}

// Optional — handy for a tiny health indicator if you want it later
export async function health() {
  return http('/health');
}
