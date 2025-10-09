import React, { useEffect, useState, useRef } from "react";
import { getStatus, startSim, stopSim, postModel } from "./api";

/* --- Tiny toast system (no deps) --- */
function useToast() {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);
  function show(message, type = "info", ms = 2400) {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type });
    timerRef.current = setTimeout(() => setToast(null), ms);
  }
  return { toast, show, clear: () => setToast(null) };
}

function Toast({ toast }) {
  if (!toast) return null;
  const bg = toast.type === "success" ? "#0f5132" : toast.type === "error" ? "#842029" : "#1f2a44";
  const border = toast.type === "success" ? "#198754" : toast.type === "error" ? "#dc3545" : "#2b3b5c";
  return (
    <div
      style={{
        position: "fixed",
        right: 18,
        bottom: 18,
        background: bg,
        color: "white",
        border: `1px solid ${border}`,
        borderRadius: 10,
        padding: "10px 14px",
        boxShadow: "0 8px 22px rgba(0,0,0,.35)",
        zIndex: 9999,
        maxWidth: 420
      }}
    >
      {toast.message}
    </div>
  );
}

/* --- Small badge/pill --- */
function Pill({ children, tone = "neutral", title }) {
  const tones = {
    neutral: { bg: "#0b0e12", bd: "#2a3444", fg: "#cbd5e1" },
    info: { bg: "#0b2547", bd: "#214b78", fg: "#93c5fd" },
    success: { bg: "#0f2f23", bd: "#165f43", fg: "#86efac" }
  }[tone];
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        borderRadius: 999,
        border: `1px solid ${tones.bd}`,
        background: tones.bg,
        color: tones.fg,
        fontSize: 12,
        lineHeight: 1
      }}
    >
      {children}
    </span>
  );
}

export default function App() {
  // Simulation params
  const [mode, setMode] = useState("catalog");         // 'catalog' | 'randomUS'
  const [eventsPerSec, setEventsPerSec] = useState(8000);
  const [batchSize, setBatchSize] = useState(1000);
  const [spread, setSpread] = useState(2.0);
  const [seed, setSeed] = useState("");                // blank = unseeded
  const [concurrency, setConcurrency] = useState(1);   // <-- NEW

  // Status / UI
  const [running, setRunning] = useState(false);
  const [cityModelText, setCityModelText] = useState("");
  const [status, setStatus] = useState(null);
  const { toast, show } = useToast();

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, []);

  async function refresh() {
    try {
      const s = await getStatus();
      setStatus(s);
      setRunning(!!s.running);
      if (typeof s.concurrency === "number") setConcurrency(s.concurrency);
    } catch {}
  }

  async function loadDefaultModel() {
    try {
      const r = await fetch("/city-model.json");
      const arr = await r.json();
      setCityModelText(JSON.stringify(arr, null, 2));
      show(`Loaded /city-model.json into editor (${arr.length} records)`, "success");
    } catch {
      show("Couldn't load /city-model.json from /public", "error");
    }
  }

  async function pushModel() {
    try {
      const arr = JSON.parse(cityModelText);
      const res = await postModel(arr);
      show(`Sent model to server: ${res.loaded} cities`, "success");
      await refresh();
    } catch {
      show("Invalid JSON or server error when sending model", "error");
    }
  }

  async function onStart() {
    const payload = {
      mode,
      eventsPerSec: Number(eventsPerSec),
      batchSize: Number(batchSize),
      spread: Number(spread),
      seed: seed === "" ? null : Number(seed),
      concurrency: Math.max(1, Number(concurrency))   // <-- NEW
    };
    try {
      const res = await startSim(payload);
      setRunning(res.running);
      setStatus(res);
      show("Simulator started", "success");
    } catch {
      show("Failed to start simulator", "error");
    }
  }

  async function onStop() {
    try {
      const res = await stopSim();
      setRunning(res.running);
      setStatus(res);
      show("Simulator stopped", "success");
    } catch {
      show("Failed to stop simulator", "error");
    }
  }

  const catalogActive = mode === "catalog";
  const epsPerWorker = Math.floor(
    Math.max(0, Number(eventsPerSec || 0)) / Math.max(1, Number(concurrency || 1))
  );

  return (
    <div className="wrap">
      <h1>US Pickup Simulator</h1>

      {/* Grid: Controls (left) | City Model (right) */}
      <div className="grid">
        {/* LEFT: Simulation Controls */}
        <div className="card">
          <h3>Simulation Controls</h3>

          <div className="row">
            <label>Mode</label>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="catalog">Catalog (weighted cities)</option>
              <option value="randomUS">Random US bounds</option>
            </select>
          </div>

          <div className="row">
            <label>Events / sec</label>
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

          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {!running ? (
              <button onClick={onStart}>Start Simulator</button>
            ) : (
              <button onClick={onStop} className="secondary">Stop</button>
            )}
            <button className="secondary" onClick={refresh}>Refresh Status</button>
            <Pill tone={running ? "success" : "neutral"}>{running ? "Running" : "Stopped"}</Pill>
            <Pill tone="info" title="eventsPerSec divided among workers">
              ~{epsPerWorker} eps/worker
            </Pill>
            <Pill tone="success" title={`Moving average over ${status?.insertsPerSecWindow ?? 10}s`}>
                Real EPS (MA): <b>{status?.insertsPerSecMA ?? 0}</b>
            </Pill>
          </div>

          <div style={{ marginTop: 12 }}>
            {status && <pre style={{ marginTop: 8 }}>{JSON.stringify(status, null, 2)}</pre>}
          </div>
        </div>

        {/* RIGHT: City Model (Catalog) */}
        <div className="card">
          <h3>City Model (Catalog)</h3>
          <p style={{ marginTop: -8, color: "#98a2b3" }}>
            {catalogActive ? (
              <>Paste your <code>us_metro_model.json</code> or click <b>Load Default</b>, then <b>Send to Server</b> to use Catalog mode.</>
            ) : (
              <><b>Random US bounds</b> selected — the simulator ignores the city model. Load/Send are disabled.</>
            )}
          </p>

          <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={loadDefaultModel} className="secondary" disabled={!catalogActive} title={catalogActive ? "" : "Disabled in Random US mode"}>
              Load Default
            </button>
            <button onClick={pushModel} disabled={!catalogActive} title={catalogActive ? "" : "Disabled in Random US mode"}>
              Send to Server
            </button>
            <Pill tone="info" title="Number of cities currently loaded into the simulator backend">
              Server model:&nbsp;<b>{status?.cityModelSize ?? 0}</b>
            </Pill>
          </div>

          <div style={{ position: "relative" }}>
            {!catalogActive && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(11,14,18,0.55)",
                  borderRadius: 10,
                  pointerEvents: "none"
                }}
              />
            )}
            <textarea
              value={cityModelText}
              onChange={(e) => setCityModelText(e.target.value)}
              disabled={!catalogActive}
              style={{
                width: "100%",
                height: "420px",
                marginTop: 8,
                background: "#0b0e12",
                color: "#e7eaee",
                border: "1px solid #263241",
                borderRadius: 10,
                padding: 10,
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
                fontSize: 13,
                opacity: catalogActive ? 1 : 0.6
              }}
              placeholder='[{"name":"New York","lat":40.7128,"lng":-74.0060,"weight":50,"sigmaKm":20}, …]'
            />
          </div>
        </div>
      </div>

      <Toast toast={toast} />
    </div>
  );
}
