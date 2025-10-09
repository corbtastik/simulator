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
  return (
    <div className={`toast toast--${toast.type}`}>
      {toast.message}
    </div>
  );
}

export default function App() {
  const { theme, toggle } = useTheme();

  // Simulation params
  const [eventsPerSec, setEventsPerSec] = useState(8000);
  const [batchSize, setBatchSize] = useState(1000);
  const [spread, setSpread] = useState(2.0);
  const [seed, setSeed] = useState("");
  const [concurrency, setConcurrency] = useState(1);

  // Status / UI
  const [running, setRunning] = useState(false);
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

  async function onStart() {
    const payload = {
      eventsPerSec: Number(eventsPerSec),
      batchSize: Number(batchSize),
      spread: Number(spread),
      seed: seed === "" ? null : Number(seed),
      concurrency: Math.max(1, Number(concurrency))
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

  const ipsPerWorker = Math.floor(
    Math.max(0, Number(eventsPerSec || 0)) / Math.max(1, Number(concurrency || 1))
  );
  const startDisabled = Number(eventsPerSec) < Number(concurrency);

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

        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {!running ? (
            <button className="primary" onClick={onStart} disabled={startDisabled}
              title={startDisabled ? "Incidents/sec must be ≥ concurrency" : ""}>
              Start Simulator
            </button>
          ) : (
            <button onClick={onStop} className="secondary">Stop</button>
          )}
          <button className="secondary" onClick={refresh}>Refresh Status</button>

          {/* Status pill */}
          <span className={`pill ${running ? "pill--status-ok" : "pill--status"}`}>
            {running ? "Running" : "Stopped"}
          </span>

          {/* IPS per worker */}
          <span className="pill pill--info" title="Incidents/sec divided among workers">
            IPS/Worker: <b className="mono">~{ipsPerWorker}</b>
          </span>

          {/* Real IPS MA */}
          <span className="pill pill--ok" title={`Moving average over ${status?.insertsPerSecWindow ?? 10}s`}>
            Real IPS (MA): <b className="mono">{status?.insertsPerSecMA ?? 0}</b>
          </span>

          {/* Cities count */}
          {typeof status?.cityModelSize === "number" && (
            <span className="pill pill--blue" title="Number of cities loaded on the server at startup">
              Cities: <b className="mono">{status.cityModelSize}</b>
            </span>
          )}
        </div>

        <pre className="status-json">
{JSON.stringify(
  status ?? {
    running: false,
    eventsPerSec: Number(eventsPerSec),
    batchSize: Number(batchSize),
    spread: Number(spread),
    seed: seed?.trim() === "" ? null : seed.trim(),
    concurrency: Number(concurrency),
    cityModelSize: 0,
    insertsPerSecMA: 0,
    insertsPerSecWindow: 10,
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
