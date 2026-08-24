import React, { useEffect, useState, useRef } from "react";
import { getStatus, startSim, stopSim } from "./api";
import "./index.css";

/* ---- Theme: icon-only Light/Dark toggle (persisted), system as initial default ---- */
function useTheme() {
  const systemPrefersDark = () =>
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("theme");
    return saved || (systemPrefersDark() ? "dark" : "light");
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggle = () => setTheme(theme === "dark" ? "light" : "dark");
  return { theme, toggle };
}

/* --- Minimal toast --- */
function useToast() {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);
  function show(message, type = "info", ms = 2400) {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type });
    timerRef.current = setTimeout(() => setToast(null), ms);
  }
  return { toast, show };
}

function Toast({ toast }) {
  if (!toast) return null;
  return <div className={`toast toast--${toast.type}`}>{toast.message}</div>;
}

/** Normalize responses from API:
 * - New shape: { ok, simulator, scheduler, persistedDb? }
 * - Legacy shape: simulator fields at top-level (no scheduler)
 */
function normalizeStatusResponse(resp) {
  if (resp && typeof resp === "object" && "simulator" in resp) {
    const simulator = resp.simulator ?? {};
    const scheduler = resp.scheduler ?? null;
    const persistedDb = resp.persistedDb ?? null;
    return { simulator, scheduler, persistedDb };
  }
  // Legacy flat response
  return { simulator: resp ?? {}, scheduler: null, persistedDb: null };
}

export default function App() {
  const { theme, toggle } = useTheme();

  // Simulation params
  const [eventsPerSec, setEventsPerSec] = useState(8000);
  const [batchSize, setBatchSize] = useState(1000);
  const [spread, setSpread] = useState(2.0);
  const [seed, setSeed] = useState("");
  const [concurrency, setConcurrency] = useState(1);

  // Repeatable mode
  const [genMode, setGenMode] = useState("continuous"); // "continuous" | "repeatable"
  const [datasetName, setDatasetName] = useState("demo-v1");
  const [repeatableCount, setRepeatableCount] = useState(1000);
  const [outputMode, setOutputMode] = useState("both"); // "atlas" | "json" | "both"
  const [mediaEnabled, setMediaEnabled] = useState(true); // attach images with embeddings
  const [mediaSource, setMediaSource] = useState("local"); // "local" | "gcs"
  const [mediaDataset, setMediaDataset] = useState("demo-v1"); // dataset name for GCS

  // Controls
  const [note, setNote] = useState(""); // Sim Run Note (optional)
  const [repairsEnabled, setRepairsEnabled] = useState(false); // single toggle (always persists)
  const [scenariosEnabled, setScenariosEnabled] = useState(false); // inject scripted scenarios
  const [scenarios, setScenarios] = useState(["warrior-cascade", "lexical-edge", "novel"]); // selected scenarios

  // Status / UI
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(null); // merged { ...simulator, scheduler, persistedDb }
  const { toast, show } = useToast();

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, []);

  async function refresh() {
    try {
      const resp = await getStatus();
      const { simulator, scheduler, persistedDb } = normalizeStatusResponse(resp);
      const isRunning = !!simulator.running;
      setRunning(isRunning);
      if (typeof simulator.concurrency === "number") setConcurrency(simulator.concurrency);

      // ✅ Only sync repairsEnabled and scenariosEnabled from server while a run is active.
      if (isRunning) {
        const serverRepairs =
          (simulator?.runParams && typeof simulator.runParams.repairsEnabled === "boolean")
            ? simulator.runParams.repairsEnabled
            : (typeof simulator.repairsEnabled === "boolean" ? simulator.repairsEnabled : undefined);
        if (typeof serverRepairs === "boolean") setRepairsEnabled(serverRepairs);

        const serverScenarios =
          (simulator?.runParams && typeof simulator.runParams.scenariosEnabled === "boolean")
            ? simulator.runParams.scenariosEnabled
            : undefined;
        if (typeof serverScenarios === "boolean") setScenariosEnabled(serverScenarios);

        const serverScenarioList =
          (simulator?.runParams && Array.isArray(simulator.runParams.scenarios))
            ? simulator.runParams.scenarios
            : undefined;
        if (serverScenarioList) setScenarios(serverScenarioList);
      }

      setStatus({ ...simulator, scheduler, persistedDb });
    } catch {
      // noop
    }
  }

  async function onStart() {
    const payload = {
      eventsPerSec: Number(eventsPerSec),
      batchSize: Number(batchSize),
      spread: Number(spread),
      seed: seed === "" ? null : Number(seed),
      concurrency: Math.max(1, Number(concurrency)),
      note: note?.trim() === "" ? null : note.trim(),
      repairsEnabled: !!repairsEnabled, // single flag; scheduler always persists when enabled
      scenariosEnabled: !!scenariosEnabled,
      scenarios: scenariosEnabled ? scenarios : [],
      // Repeatable mode fields
      genMode,
      ...(genMode === "repeatable" && {
        datasetName: datasetName?.trim() || "demo-v1",
        repeatableCount: Math.max(1, Number(repeatableCount)),
        outputMode,
        mediaEnabled: !!mediaEnabled,
        mediaSource,
        mediaDataset: mediaDataset?.trim() || "demo-v1",
      }),
    };

    try {
      const resp = await startSim(payload);
      const { simulator, scheduler, persistedDb } = normalizeStatusResponse(resp);
      setRunning(!!simulator.running);
      setStatus({ ...simulator, scheduler, persistedDb });
      // After start, server owns truth; refresh will now sync checkbox from server
      show("Simulator started", "success");
    } catch {
      show("Failed to start simulator", "error");
    }
  }

  async function onStop() {
    try {
      const resp = await stopSim();
      const { simulator, scheduler, persistedDb } = normalizeStatusResponse(resp);
      setRunning(!!simulator.running);
      setStatus({ ...simulator, scheduler, persistedDb });
      show("Simulator stopped", "success");
    } catch {
      show("Failed to stop simulator", "error");
    }
  }

  const ipsPerWorker = Math.floor(
    Math.max(0, Number(eventsPerSec || 0)) / Math.max(1, Number(concurrency || 1))
  );
  const startDisabled = Number(eventsPerSec) < Number(concurrency);

  const Divider = () => (
    <div
      style={{
        borderTop: "1px solid var(--border-color, rgba(255,255,255,0.12))",
        margin: "14px 0",
      }}
    />
  );

  // Scheduler pills
  const schedulerState = status?.scheduler?.state ?? "idle";

  const schedulerPill = (
    <span
      className={`pill ${schedulerState === "running" ? "pill--status-ok" : "pill--status"}`}
      title="Phase-3 repair scheduler"
    >
      Repairs: <b className="mono">{schedulerState}</b>
    </span>
  );

  const persistedSession = status?.scheduler?.persisted ?? 0;
  const duplicatesIgnored = status?.scheduler?.duplicatesIgnored ?? 0;
  const persistedDb = status?.persistedDb ?? null;

  return (
    <div className="wrap">
      <div className="header-bar">
        <h1>U.S. Incidents Simulator</h1>
        <button
          className="theme-toggle"
          onClick={toggle}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? "🌙" : "☀️"}
        </button>
      </div>

      <div className="card" style={{ maxWidth: 980 }}>
        <h3>Simulation Controls</h3>

        {/* --- Sim Run Note (top) --- */}
        <div className="row">
          <label>Sim Run Note</label>
          <input
            type="text"
            placeholder="Why you're running this (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
          />
        </div>

        <Divider />

        {/* --- Generation Mode --- */}
        <div className="row" style={{ alignItems: "flex-start", gap: 12, flexDirection: "column" }}>
          <label style={{ fontWeight: 600, marginBottom: 4 }}>Generation Mode</label>
          <div style={{ display: "flex", gap: 20 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
              <input
                type="radio"
                name="genMode"
                checked={genMode === "continuous"}
                onChange={() => setGenMode("continuous")}
              />
              <span>Continuous</span>
              <span style={{ opacity: 0.6, fontSize: 12 }}>— streams indefinitely</span>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
              <input
                type="radio"
                name="genMode"
                checked={genMode === "repeatable"}
                onChange={() => setGenMode("repeatable")}
              />
              <span>Repeatable</span>
              <span style={{ opacity: 0.6, fontSize: 12 }}>— fixed dataset</span>
            </label>
          </div>

        </div>

        {genMode === "repeatable" && (
          <>
            <Divider />
            <div className="row">
              <label>Dataset Name</label>
              <input
                type="text"
                placeholder="demo-v1"
                value={datasetName}
                onChange={(e) => setDatasetName(e.target.value)}
              />
              <span style={{ opacity: 0.6, fontSize: 12, marginLeft: 8 }}>used as seed for reproducibility</span>
            </div>
            <div className="row">
              <label>Count</label>
              <input
                type="number"
                min="1"
                max="100000"
                value={repeatableCount}
                onChange={(e) => setRepeatableCount(e.target.value)}
              />
              <span style={{ opacity: 0.6, fontSize: 12, marginLeft: 8 }}>incidents to generate</span>
            </div>
            <div className="row" style={{ alignItems: "center", gap: 16 }}>
              <label style={{ minWidth: 60 }}>Output</label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="outputMode"
                  checked={outputMode === "atlas"}
                  onChange={() => setOutputMode("atlas")}
                />
                Atlas
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="outputMode"
                  checked={outputMode === "json"}
                  onChange={() => setOutputMode("json")}
                />
                JSON
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="outputMode"
                  checked={outputMode === "both"}
                  onChange={() => setOutputMode("both")}
                />
                Both
              </label>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={mediaEnabled}
                  onChange={(e) => setMediaEnabled(e.target.checked)}
                />
                Attach Images
                <span style={{ opacity: 0.6, fontSize: 12 }}>— multimodal embeddings (~30% of incidents)</span>
              </label>
            </div>

            {mediaEnabled && (
              <>
                <div className="row" style={{ marginTop: 8, alignItems: "center", gap: 16, marginLeft: 24 }}>
                  <label style={{ minWidth: 80 }}>Image Source</label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="mediaSource"
                      checked={mediaSource === "local"}
                      onChange={() => setMediaSource("local")}
                    />
                    Local
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="mediaSource"
                      checked={mediaSource === "gcs"}
                      onChange={() => setMediaSource("gcs")}
                    />
                    GCS Bucket
                  </label>
                </div>
                {mediaSource === "gcs" && (
                  <div className="row" style={{ marginTop: 4, marginLeft: 24 }}>
                    <label style={{ minWidth: 80 }}>Dataset</label>
                    <input
                      type="text"
                      placeholder="demo-v1"
                      value={mediaDataset}
                      onChange={(e) => setMediaDataset(e.target.value)}
                      style={{ maxWidth: 200 }}
                    />
                  </div>
                )}
              </>
            )}
          </>
        )}

        <Divider />

        <div className="row">
          <label>Incidents / sec</label>
          <input
            type="number"
            min="1"
            step="100"
            value={eventsPerSec}
            onChange={(e) => setEventsPerSec(e.target.value)}
          />
        </div>

        <div className="row">
          <label>Batch size</label>
          <input
            type="number"
            min="1"
            step="100"
            value={batchSize}
            onChange={(e) => setBatchSize(e.target.value)}
          />
        </div>

        <div className="row">
          <label>Concurrency</label>
          <input
            type="number"
            min="1"
            max="128"
            step="1"
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
          />
        </div>

        <div className="row">
          <label>Spread (σ factor)</label>
          <input
            type="range"
            min="0.2"
            max="5"
            step="0.1"
            value={spread}
            onChange={(e) => setSpread(e.target.value)}
          />
          <span>{Number(spread).toFixed(1)}×</span>
        </div>

        <div className="row">
          <label>Seed (optional)</label>
          <input
            type="text"
            placeholder="empty = random"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
        </div>

        <Divider />

        {/* --- Repair toggle (single) --- */}
        <div className="row" style={{ alignItems: "center", gap: 16 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={repairsEnabled}
              onChange={(e) => setRepairsEnabled(e.target.checked)}
            />
            Enable Repair <span style={{ opacity: 0.7 }}>(always persists)</span>
          </label>
        </div>

        {/* --- Scenarios toggle --- */}
        <div className="row" style={{ alignItems: "flex-start", gap: 16, flexDirection: "column" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={scenariosEnabled}
              onChange={(e) => setScenariosEnabled(e.target.checked)}
            />
            Inject Scenarios <span style={{ opacity: 0.7 }}>(deterministic demo incidents)</span>
          </label>

          {scenariosEnabled && (
            <div style={{ marginLeft: 24, display: "flex", flexDirection: "column", gap: 6 }}>
              {[
                { id: "warrior-cascade", label: "Warrior Cascade", desc: "6-incident systemic cluster + control" },
                { id: "lexical-edge", label: "Lexical Edge", desc: "3 docs for hybrid search demo" },
                { id: "novel", label: "Novel Incident", desc: "1 unprecedented failure" },
              ].map(({ id, label, desc }) => (
                <label key={id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={scenarios.includes(id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setScenarios([...scenarios, id]);
                      } else {
                        setScenarios(scenarios.filter((s) => s !== id));
                      }
                    }}
                  />
                  <span>{label}</span>
                  <span style={{ opacity: 0.6, fontSize: 12 }}>— {desc}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <Divider />

        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {!running ? (
            <button
              className="primary"
              onClick={onStart}
              disabled={startDisabled}
              title={startDisabled ? "Incidents/sec must be ≥ concurrency" : ""}
            >
              Start Simulator
            </button>
          ) : (
            <button onClick={onStop} className="secondary">
              Stop
            </button>
          )}
          <button className="secondary" onClick={refresh}>
            Refresh Status
          </button>

          {/* Status pills */}
          <span className={`pill ${running ? "pill--status-ok" : "pill--status"}`}>
            {running ? "Running" : "Stopped"}
          </span>
          {schedulerPill}

          {/* IPS per worker */}
          <span className="pill pill--info" title="Incidents/sec divided among workers">
            IPS/Worker: <b className="mono">~{ipsPerWorker}</b>
          </span>

          {/* Real IPS MA */}
          <span
            className="pill pill--ok"
            title={`Moving average over ${status?.insertsPerSecWindow ?? 10}s`}
          >
            Real IPS (MA): <b className="mono">{status?.insertsPerSecMA ?? 0}</b>
          </span>

          {/* Cities count */}
          {typeof status?.cityModelSize === "number" && (
            <span
              className="pill pill--blue"
              title="Number of cities loaded on the server at startup"
            >
              Cities: <b className="mono">{status.cityModelSize}</b>
            </span>
          )}

          {/* Persist metrics */}
          <span className="pill pill--info" title="Rows inserted this session (since start)">
            Persisted: <b className="mono">{persistedSession}</b>
          </span>
          <span className="pill" title="Duplicates ignored by unique index">
            Dupes: <b className="mono">{duplicatesIgnored}</b>
          </span>
          {persistedDb !== null && (
            <span className="pill" title="DB count for current simRunId">
              DB Count: <b className="mono">{persistedDb}</b>
            </span>
          )}

          {/* Repeatable mode progress */}
          {status?.repeatableProgress && (
            <span className="pill pill--info" title="Repeatable mode progress">
              Progress: <b className="mono">{status.repeatableProgress.current} / {status.repeatableProgress.total}</b>
            </span>
          )}
          {status?.repeatableProgress?.mediaEnabled && (
            <span className="pill pill--blue" title="Media documents with embeddings created">
              Media: <b className="mono">{status.repeatableProgress.mediaCount ?? 0}</b>
            </span>
          )}
        </div>

        {/* Progress bar for repeatable mode */}
        {running && status?.repeatableProgress && (
          <div style={{ marginTop: 12 }}>
            <div style={{
              background: "var(--border-color, rgba(255,255,255,0.12))",
              borderRadius: 6,
              height: 8,
              overflow: "hidden"
            }}>
              <div style={{
                background: "var(--accent, #3b82f6)",
                height: "100%",
                width: `${Math.min(100, (status.repeatableProgress.current / status.repeatableProgress.total) * 100)}%`,
                transition: "width 0.3s ease"
              }} />
            </div>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, textAlign: "center" }}>
              {Math.round((status.repeatableProgress.current / status.repeatableProgress.total) * 100)}% complete
              {status.repeatableProgress.outputMode && ` — Output: ${status.repeatableProgress.outputMode}`}
              {status.repeatableProgress.mediaEnabled && ` — Media: ${status.repeatableProgress.mediaCount ?? 0}`}
            </div>
          </div>
        )}

        <pre className="status-json">
{JSON.stringify(
  // Keep a single JSON blob for easy debugging: simulator fields + nested scheduler
  status ?? {
    running: false,
    eventsPerSec: Number(eventsPerSec),
    batchSize: Number(batchSize),
    spread: Number(spread),
    seed: seed?.trim() === "" ? null : seed.trim(),
    concurrency: Number(concurrency),
    repairsEnabled: !!repairsEnabled,
    note: note?.trim() === "" ? null : note.trim(),
    cityModelSize: 0,
    insertsPerSecMA: 0,
    insertsPerSecWindow: 10,
    scheduler: { state: "idle", persisted: 0, duplicatesIgnored: 0 },
  },
  null,
  2
)}
        </pre>
      </div>

      <Toast toast={toast} />
    </div>
  );
}
