import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend,
} from "recharts";
import {
  Key, Activity, AlertTriangle, Shield, Play, Pause, Plus, Eye, EyeOff,
  Trash2, Zap, RefreshCw, CheckCircle2, XCircle, Radio, Power, Wrench,
} from "lucide-react";

/* =========================================================================
   GRAFANA-INSPIRED PALETTE
   ========================================================================= */
const C = {
  bg: "#0B0C0E",
  panel: "#141619",
  panel2: "#1A1D21",
  border: "#2C3235",
  text: "#D8D9DA",
  muted: "#8E9297",
  green: "#73BF69",
  yellow: "#F2CC0C",
  orange: "#FF9830",
  red: "#F2495C",
  blue: "#5794F2",
  purple: "#B877D9",
  cyan: "#37D0D6",
};
const SERIES_COLORS = [C.green, C.blue, C.purple, C.orange, C.cyan, C.yellow];
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

/* =========================================================================
   STATUS MODEL (unchanged logic — derived, never stored)
   ========================================================================= */
const STATUS = {
  healthy:   { label: "Healthy",    color: C.green,  Icon: CheckCircle2 },
  warning:   { label: "Near limit", color: C.yellow, Icon: AlertTriangle },
  exhausted: { label: "Exhausted",  color: C.red,    Icon: XCircle },
  error:     { label: "Error",      color: C.red,    Icon: AlertTriangle },
  disabled:  { label: "Disabled",   color: C.muted,  Icon: Power },
};
const ERROR_LABEL = {
  rate_limited: "429 rate limited",
  invalid: "401 invalid key",
  expired: "403 expired / revoked",
  circuit: "circuit breaker open",
};
const pct = (k) => (k.limit > 0 ? Math.min(100, (k.used / k.limit) * 100) : 0);
function deriveStatus(k, threshold) {
  if (!k.enabled) return "disabled";
  if (k.errorType) return "error";
  if (pct(k) >= 100) return "exhausted";
  if (pct(k) >= threshold) return "warning";
  return "healthy";
}
const isRoutable = (k, t) => ["healthy", "warning"].includes(deriveStatus(k, t));

function selectKey(keys, { strategy, activeId, threshold }) {
  const candidates = keys.filter((k) => isRoutable(k, threshold));
  if (!candidates.length) return null;
  if (strategy === "round") {
    const start = keys.findIndex((k) => k.id === activeId);
    for (let i = 1; i <= keys.length; i++) {
      const k = keys[(start + i) % keys.length];
      if (isRoutable(k, threshold)) return k;
    }
    return candidates[0];
  }
  return candidates.slice().sort((a, b) => pct(a) - pct(b))[0];
}
const shouldSwitch = (k, t) => !k || !k.enabled || !!k.errorType || pct(k) >= t;

const seed = () => [
  { id: "k1", label: "CRM email drafting", provider: "Anthropic",
    key: "sk-ant-live-9f2c7a41d8e0", limit: 100000, used: 61000, enabled: true, errorType: null },
  { id: "k2", label: "Website chatbot", provider: "Anthropic",
    key: "sk-ant-live-3b81ee52c604", limit: 100000, used: 88000, enabled: true, errorType: null },
  { id: "k3", label: "Backup pool", provider: "OpenAI",
    key: "sk-proj-27aa10fbd399", limit: 50000, used: 4200, enabled: true, errorType: null },
];
const mask = (s) => (s.length <= 10 ? "••••••" : `${s.slice(0, 7)}••••${s.slice(-4)}`);
const fmt = (n) => Math.round(n).toLocaleString();
const gaugeColor = (p, threshold) => (p >= 100 ? C.red : p >= threshold ? C.yellow : C.green);

/* =========================================================================
   GRAFANA-STYLE RADIAL GAUGE (SVG arc with threshold coloring)
   ========================================================================= */
function Gauge({ value, label, sub, threshold = 80, size = 108 }) {
  const clamped = Math.min(100, Math.max(0, value));
  const r = size / 2 - 10;
  const cx = size / 2, cy = size / 2;
  // 270° sweep starting at 135°
  const polar = (deg) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const arc = (fromDeg, toDeg) => {
    const [x1, y1] = polar(fromDeg);
    const [x2, y2] = polar(toDeg);
    const large = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };
  const start = -135, sweep = 270;
  const valDeg = start + (sweep * clamped) / 100;
  const color = gaugeColor(clamped, threshold);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <svg width={size} height={size}>
        <path d={arc(start, start + sweep)} fill="none" stroke={C.panel2} strokeWidth={9} strokeLinecap="round" />
        {clamped > 0 && (
          <path d={arc(start, valDeg)} fill="none" stroke={color} strokeWidth={9}
            strokeLinecap="round" style={{ transition: "all .4s ease", filter: `drop-shadow(0 0 4px ${color}66)` }} />
        )}
        {/* threshold tick */}
        <circle {...(([x, y]) => ({ cx: x, cy: y }))(polar(start + (sweep * threshold) / 100))}
          r={2.5} fill={C.text} opacity={0.6} />
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize={size * 0.21} fontWeight={700}
          fontFamily={MONO} fill={color}>{Math.round(clamped)}%</text>
        <text x={cx} y={cy + size * 0.14} textAnchor="middle" fontSize={10.5}
          fontFamily={SANS} fill={C.muted}>{sub}</text>
      </svg>
      <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.muted, textAlign: "center", marginTop: -6 }}>{label}</div>
    </div>
  );
}

/* =========================================================================
   HEATMAP — per-key request intensity over time (the Grafana CPU grid)
   ========================================================================= */
const HEAT_COLS = 26;
function heatColor(v, max) {
  if (v <= 0) return C.panel2;
  const t = Math.min(1, v / Math.max(1, max));
  if (t < 0.34) return C.green;
  if (t < 0.67) return C.yellow;
  return C.red;
}
function Heatmap({ keys, heat }) {
  const max = Math.max(1, ...Object.values(heat).flat());
  return (
    <div style={{ display: "grid", gap: 5 }}>
      {keys.map((k) => {
        const row = heat[k.id] || [];
        const padded = [...Array(Math.max(0, HEAT_COLS - row.length)).fill(0), ...row.slice(-HEAT_COLS)];
        return (
          <div key={k.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              fontFamily: MONO, fontSize: 10.5, color: C.muted, width: 92, flexShrink: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right",
            }}>{k.label}</div>
            <div style={{ display: "flex", gap: 2, flex: 1 }}>
              {padded.map((v, i) => (
                <div key={i} title={`${v} tok`} style={{
                  flex: 1, height: 13, borderRadius: 2, background: heatColor(v, max),
                  opacity: v > 0 ? 0.55 + 0.45 * Math.min(1, v / max) : 1,
                }} />
              ))}
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
        {[["low", C.green], ["med", C.yellow], ["high", C.red]].map(([l, c]) => (
          <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: C.muted, fontFamily: SANS }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: c }} /> {l}
          </span>
        ))}
      </div>
    </div>
  );
}

/* =========================================================================
   TERMINAL PANEL — structured logs, same shape the real backend emits
   ========================================================================= */
function Terminal({ log }) {
  const lvlColor = { info: C.blue, switch: C.cyan, error: C.red, warn: C.yellow };
  return (
    <div style={{
      background: "#0A0B0D", border: `1px solid ${C.border}`, borderRadius: 8,
      padding: "10px 12px", height: "100%", minHeight: 190, maxHeight: 420, overflowY: "auto",
      fontFamily: MONO, fontSize: 11, lineHeight: 1.75,
    }}>
      <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
        {[C.red, C.yellow, C.green].map((c) => (
          <span key={c} style={{ width: 9, height: 9, borderRadius: 999, background: c }} />
        ))}
        <span style={{ color: C.muted, marginLeft: 6, fontSize: 10.5 }}>key-router · structured logs</span>
      </div>
      {log.length === 0 && <span style={{ color: C.muted }}>$ waiting for traffic…</span>}
      {log.map((e) => (
        <div key={e.id} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ color: C.muted }}>{`{"ts":"${e.t.toLocaleTimeString("en-US", { hour12: false })}"`}</span>
          <span style={{ color: C.muted }}>,"level":</span>
          <span style={{ color: lvlColor[e.type] || C.text }}>"{e.type}"</span>
          <span style={{ color: C.muted }}>,"msg":</span>
          <span style={{ color: C.text }}>"{e.msg}"</span>
          <span style={{ color: C.muted }}>{"}"}</span>
        </div>
      ))}
    </div>
  );
}

/* =========================================================================
   PANEL WRAPPER — Grafana card chrome
   ========================================================================= */
function Panel({ title, right, children, accent, className }) {
  return (
    <div className={className} style={{
      background: C.panel, border: `1px solid ${accent ? accent + "55" : C.border}`,
      borderRadius: 4, overflow: "hidden", display: "flex", flexDirection: "column",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "8px 12px", borderBottom: `1px solid ${C.border}`,
      }}>
        <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 600, color: C.text }}>{title}</span>
        {right}
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}

/* =========================================================================
   KEY CARD (condensed, Grafana table-row feel)
   ========================================================================= */
function KeyCard({ k, active, threshold, revealed, onReveal, onToggle, onDelete, onInject, onFix, onEdit, color, readOnly }) {
  const status = deriveStatus(k, threshold);
  const sColor = STATUS[status].color;
  const p = pct(k);
  return (
    <div style={{
      background: C.panel2, border: `1px solid ${active ? C.green : C.border}`,
      borderLeft: `3px solid ${color}`, borderRadius: 4, padding: 12,
      boxShadow: active ? `0 0 14px -6px ${C.green}` : "none",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 14, color: C.text }}>{k.label}</span>
          {active && (
            <span className="kr-live" style={{
              fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8,
              color: C.bg, background: C.green, borderRadius: 3, padding: "2px 6px",
              display: "inline-flex", alignItems: "center", gap: 4,
            }}><Radio size={10} /> ROUTING</span>
          )}
        </div>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontFamily: MONO,
          color: sColor, border: `1px solid ${sColor}55`, background: `${sColor}14`,
          borderRadius: 3, padding: "2px 7px",
        }}>{STATUS[status].label.toUpperCase()}</span>
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 8,
        fontFamily: MONO, fontSize: 11.5, color: C.muted,
      }}>
        <Key size={12} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {revealed ? k.key : mask(k.key)}
        </span>
        <button onClick={() => onReveal(k.id)} style={iconBtn}>{revealed ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 11, marginBottom: 4 }}>
          <span style={{ color: C.text }}>{fmt(k.used)} / {fmt(k.limit)}</span>
          <span style={{ color: sColor }}>{p.toFixed(0)}%</span>
        </div>
        <div style={{ position: "relative", height: 6, background: "#0A0B0D", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, width: `${p}%`, background: sColor, transition: "width .35s" }} />
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${threshold}%`, width: 1.5, background: C.text, opacity: 0.4 }} />
        </div>
        {status === "error" && (
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red, marginTop: 5 }}>{ERROR_LABEL[k.errorType]} — skipped by router</div>
        )}
      </div>

      {!readOnly && (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
        <button onClick={() => onToggle(k.id)} style={chip(k.enabled ? C.muted : C.green)}><Power size={12} /> {k.enabled ? "Disable" : "Enable"}</button>
        {k.errorType
          ? <button onClick={() => onFix(k.id)} style={chip(C.cyan)}><Wrench size={12} /> Re-test</button>
          : <button onClick={() => onInject(k.id)} style={chip(C.yellow)}><AlertTriangle size={12} /> Simulate issue</button>}
        <button onClick={() => onEdit(k)} style={chip(C.muted)}><RefreshCw size={12} /> Edit</button>
        <button onClick={() => onDelete(k.id)} style={chip(C.red)}><Trash2 size={12} /> Remove</button>
      </div>
      )}
    </div>
  );
}

/* =========================================================================
   ADD / EDIT MODAL
   ========================================================================= */
function KeyModal({ initial, onClose, onSave }) {
  const [label, setLabel] = useState(initial?.label || "");
  const [provider, setProvider] = useState(initial?.provider || "Anthropic");
  const [keyVal, setKeyVal] = useState(initial?.key || "");
  const [limit, setLimit] = useState(initial?.limit || 100000);
  const valid = label.trim() && keyVal.trim().length >= 8 && Number(limit) > 0;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#000B", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50, padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 18 }}>
        <div style={{ fontFamily: SANS, fontWeight: 700, color: C.text, fontSize: 16, marginBottom: 4 }}>{initial ? "Edit key" : "Add API key"}</div>
        <div style={{ fontFamily: SANS, fontSize: 12, color: C.muted, marginBottom: 14 }}>Use keys you own. In production this saves to your backend, not the browser.</div>
        {[["Label", label, setLabel, "e.g. Chatbot production", "text"],
          ["API key", keyVal, setKeyVal, "sk-…", "mono"],
          ["Token limit (per window)", limit, setLimit, "", "number"]].map(([lab, val, set, ph, kind]) => (
          <div key={lab} style={{ marginBottom: 12 }}>
            <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.muted, marginBottom: 4 }}>{lab}</div>
            <input type={kind === "number" ? "number" : "text"} value={val} placeholder={ph}
              onChange={(e) => set(e.target.value)}
              style={{ ...input, fontFamily: kind === "mono" ? MONO : SANS }} />
          </div>
        ))}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.muted, marginBottom: 4 }}>Provider</div>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} style={input}>
            {["Anthropic", "OpenAI", "Google", "Custom"].map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ ...chip(C.muted), flex: 1, justifyContent: "center", padding: 11 }}>Cancel</button>
          <button disabled={!valid}
            onClick={() => onSave({ ...(initial || {}), label: label.trim(), provider, key: keyVal.trim(), limit: Number(limit) })}
            style={{ flex: 1, display: "inline-flex", justifyContent: "center", alignItems: "center", gap: 6, padding: 11, fontFamily: SANS, fontWeight: 700, fontSize: 13, borderRadius: 4, border: "none", color: C.bg, background: valid ? C.green : C.muted, cursor: valid ? "pointer" : "not-allowed" }}>
            <CheckCircle2 size={14} /> {initial ? "Save" : "Add key"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   LIVE MODE — poll the real Key Router backend's /v1/status endpoint.
   The Vite dev proxy forwards /v1/* to localhost:8787, so requests are
   same-origin in dev. The bearer token lives in React state only: never
   localStorage, never a cookie — it dies with the tab, as a secret should.
   ========================================================================= */
function useLiveStatus({ enabled, token, intervalMs = 3000 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!enabled) { setData(null); setError(null); return; }
    let stopped = false;
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    async function poll() {
      try {
        const res = await fetch("/v1/status", { headers });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const body = await res.json();
        if (!stopped) { setData(body); setError(null); }
      } catch (err) {
        if (!stopped) setError(err.message);
      }
    }
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { stopped = true; clearInterval(id); };
  }, [enabled, token, intervalMs]);
  return { data, error };
}

/* =========================================================================
   MAIN
   ========================================================================= */
export default function KeyRouter() {
  const [keys, setKeys] = useState(seed);
  const [threshold, setThreshold] = useState(80);
  const [strategy, setStrategy] = useState("lowest");
  const [auto, setAuto] = useState(true);
  const [activeId, setActiveId] = useState("k1");
  const [revealed, setRevealed] = useState({});
  const [log, setLog] = useState([]);
  const [series, setSeries] = useState([]);   // [{t, k1: tok, k2: tok, ...}]
  const [heat, setHeat] = useState({});       // {keyId: [tok, tok, ...]}
  const [streaming, setStreaming] = useState(false);
  const [modal, setModal] = useState(null);
  const tick = useRef(0);

  // Live mode plumbing
  const [mode, setMode] = useState("demo"); // "demo" | "live"
  const [token, setToken] = useState("");
  const isLive = mode === "live";
  const live = useLiveStatus({ enabled: isLive, token });
  const prevUsed = useRef({});

  const keyColor = useMemo(() => {
    const m = {};
    keys.forEach((k, i) => { m[k.id] = SERIES_COLORS[i % SERIES_COLORS.length]; });
    return m;
  }, [keys]);

  const pushLog = useCallback((type, msg) => {
    setLog((l) => [{ id: Date.now() + Math.random(), t: new Date(), type, msg }, ...l].slice(0, 60));
  }, []);

  // LIVE MODE: sync polled backend state into the dashboard. Every panel
  // reads the same StatusResponse schema the backend contract-tests.
  useEffect(() => {
    if (!isLive || !live.data) return;
    const mapped = live.data.keys.map((k) => ({
      id: k.id,
      label: k.id,
      provider: k.provider,
      key: k.key, // already redacted server-side — raw secrets never arrive
      limit: k.limit,
      used: k.used,
      enabled: k.enabled,
      errorType: k.breaker.state !== "closed" ? "circuit" : null,
    }));
    setKeys(mapped);
    setActiveId(live.data.keys.find((k) => k.active)?.id ?? null);
    setThreshold(live.data.config.thresholdPct);
    setStrategy(live.data.config.strategy === "round-robin" ? "round" : "lowest");

    // Usage deltas between polls become chart + heatmap points.
    const deltas = {};
    let any = false;
    mapped.forEach((k) => {
      const d = Math.max(0, k.used - (prevUsed.current[k.id] ?? k.used));
      deltas[k.id] = d;
      if (d > 0) any = true;
      prevUsed.current[k.id] = k.used;
    });
    if (any) {
      tick.current += 1;
      setSeries((s) => [...s, { t: tick.current, ...deltas }].slice(-40));
      setHeat((h) => {
        const next = {};
        mapped.forEach((k) => {
          next[k.id] = [...(h[k.id] || []), deltas[k.id]].slice(-HEAT_COLS);
        });
        return next;
      });
    }
  }, [isLive, live.data]);

  const sendRequest = useCallback(() => {
    if (isLive) {
      fetch("/v1/route", {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify({ tokens: 1000 }),
      })
        .then(async (r) => ({ ok: r.ok, body: await r.json() }))
        .then(({ ok, body }) => {
          if (!ok) pushLog("error", body.error || "route failed");
          else if (body.rotated) pushLog("switch", `rotated -> ${body.keyId} (${body.reason})`);
        })
        .catch((e) => pushLog("error", `backend unreachable: ${e.message}`));
      return; // fleet state arrives via the next /v1/status poll
    }

    // DEMO MODE. Decide routing BEFORE any setState: React 18 batches
    // updater functions and runs them after this handler returns, so a
    // variable assigned inside setKeys(...) would still be null when
    // setSeries/setHeat read it. `keys` is in the deps array, so this
    // closure always sees current state.
    const active = keys.find((k) => k.id === activeId);
    let routeId = activeId;
    if (auto && shouldSwitch(active, threshold)) {
      const picked = selectKey(keys, { strategy, activeId, threshold });
      if (!picked) {
        pushLog("error", "All keys down — no healthy key to route to");
        setStreaming(false);
        return;
      }
      if (picked.id !== activeId) {
        const reason = !active ? "no active key"
          : active.errorType ? ERROR_LABEL[active.errorType]
          : pct(active) >= 100 ? "quota spent"
          : `crossed ${threshold}% threshold`;
        pushLog("switch", `rotated ${active ? active.label : "traffic"} -> ${picked.label} (${reason})`);
        setActiveId(picked.id);
        routeId = picked.id;
      }
    } else if (active && !isRoutable(active, threshold)) {
      pushLog("error", `${active.label} unroutable and auto-switch is off`);
      setStreaming(false);
      return;
    }

    setKeys((prev) => prev.map((k) => (k.id === routeId ? { ...k, used: k.used + 1000 } : k)));

    tick.current += 1;
    const t = tick.current;
    setSeries((s) => {
      const point = { t };
      keys.forEach((k) => { point[k.id] = k.id === routeId ? 1000 : 0; });
      return [...s, point].slice(-40);
    });
    setHeat((h) => {
      const next = {};
      keys.forEach((k) => {
        const row = [...(h[k.id] || []), k.id === routeId ? 1000 : 0];
        next[k.id] = row.slice(-HEAT_COLS);
      });
      return next;
    });
  }, [activeId, auto, strategy, threshold, keys, pushLog, isLive, token]);

  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(sendRequest, 600);
    return () => clearInterval(id);
  }, [streaming, sendRequest]);

  const revealToggle = (id) => setRevealed((r) => ({ ...r, [id]: !r[id] }));
  const toggleKey = (id) => {
    const k = keys.find((x) => x.id === id);
    setKeys((ks) => ks.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)));
    pushLog("info", `${k.label} ${k.enabled ? "disabled" : "enabled"}`);
  };
  const injectIssue = (id) => {
    const types = Object.keys(ERROR_LABEL);
    const errorType = types[Math.floor(Math.random() * types.length)];
    setKeys((ks) => ks.map((k) => (k.id === id ? { ...k, errorType } : k)));
    pushLog("error", `${keys.find((x) => x.id === id).label}: ${ERROR_LABEL[errorType]} detected`);
  };
  const fixKey = (id) => {
    setKeys((ks) => ks.map((k) => (k.id === id ? { ...k, errorType: null } : k)));
    pushLog("info", `${keys.find((x) => x.id === id).label} re-tested: healthy`);
  };
  const deleteKey = (id) => {
    setKeys((ks) => ks.filter((k) => k.id !== id));
    if (activeId === id) setActiveId(null);
  };
  const saveKey = (data) => {
    if (data.id) {
      setKeys((ks) => ks.map((k) => (k.id === data.id ? { ...k, ...data } : k)));
      pushLog("info", `${data.label} updated`);
    } else {
      setKeys((ks) => [...ks, { ...data, id: "k" + Date.now(), used: 0, enabled: true, errorType: null }]);
      pushLog("info", `added key: ${data.label}`);
    }
    setModal(null);
  };
  const resetUsage = () => {
    setKeys((ks) => ks.map((k) => ({ ...k, used: Math.round(k.limit * 0.05), errorType: null, enabled: true })));
    setSeries([]); setHeat({}); tick.current = 0;
    pushLog("info", "usage windows reset");
  };

  // Fleet-level stats for the gauges
  const totalLimit = keys.reduce((s, k) => s + k.limit, 0);
  const totalUsed = keys.reduce((s, k) => s + Math.min(k.used, k.limit), 0);
  const fleetPct = totalLimit ? (totalUsed / totalLimit) * 100 : 0;
  const active = keys.find((k) => k.id === activeId);
  const routableCount = keys.filter((k) => isRoutable(k, threshold)).length;
  const issues = keys.map((k) => ({ k, s: deriveStatus(k, threshold) }))
    .filter(({ s }) => ["error", "exhausted", "warning"].includes(s));

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: SANS, padding: "14px 10px 40px" }}>
      <style>{`
        button { cursor: pointer; }
        @media (prefers-reduced-motion: no-preference) {
          .kr-live { animation: krpulse 1.5s ease-in-out infinite; }
          @keyframes krpulse { 0%,100%{opacity:1} 50%{opacity:.5} }
        }
        input, select { outline: none; }
        input:focus, select:focus { border-color: ${C.green} !important; }
        ::placeholder { color: ${C.muted}; }
        ::-webkit-scrollbar { width: 6px; } 
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }

        /* Grafana-style 12-column dashboard grid */
        .kr-grid {
          display: grid;
          grid-template-columns: repeat(12, 1fr);
          gap: 10px;
          align-items: stretch;
        }
        .span12 { grid-column: span 12; }
        .span8  { grid-column: span 8; }
        .span7  { grid-column: span 7; }
        .span6  { grid-column: span 6; }
        .span5  { grid-column: span 5; }
        .span4  { grid-column: span 4; }
        @media (max-width: 1000px) {
          .span8, .span7 { grid-column: span 12; }
          .span6, .span5, .span4 { grid-column: span 6; }
        }
        @media (max-width: 640px) {
          .span8, .span7, .span6, .span5, .span4 { grid-column: span 12; }
        }
        .kr-keys-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 8px;
        }
      `}</style>

      <div className="kr-grid" style={{ maxWidth: 1320, margin: "0 auto" }}>
        {/* Header */}
        <div className="span12" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "0 2px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <Zap size={20} color={C.green} />
            <div>
              <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: -0.2 }}>Key Router</div>
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted }}>fleet observability · auto-failover</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setStreaming((s) => !s)} style={{ ...chip(streaming ? C.yellow : C.green), padding: "8px 13px", fontWeight: 700 }}>
              {streaming ? <Pause size={13} /> : <Play size={13} />} {streaming ? "Pause" : "Traffic"}
            </button>
            <button onClick={sendRequest} style={chip(C.muted)}><Activity size={13} /> +1</button>
            <button onClick={resetUsage} style={chip(C.muted)}><RefreshCw size={13} /></button>
          </div>
        </div>

        {/* CONNECTION */}
        <Panel className="span12" title="Backend connection" right={
          isLive ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 10.5, color: live.error ? C.red : live.data ? C.green : C.yellow }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: live.error ? C.red : live.data ? C.green : C.yellow }} />
              {live.error ? `error: ${live.error}` : live.data ? "connected · polling 3s" : "connecting…"}
            </span>
          ) : (
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted }}>simulation · no server needed</span>
          )
        }>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>
              {["demo", "live"].map((m) => (
                <button key={m} onClick={() => setMode(m)} style={{
                  padding: "7px 16px", fontSize: 12, fontWeight: 700, fontFamily: SANS, border: "none",
                  background: mode === m ? C.green : "transparent", color: mode === m ? C.bg : C.muted,
                }}>{m.toUpperCase()}</button>
              ))}
            </div>
            {isLive && (
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
                placeholder="KEYROUTER_AUTH_TOKEN — held in memory only, dies with the tab"
                style={{ ...input, flex: "1 1 280px", fontFamily: MONO }} />
            )}
            {isLive && (
              <span style={{ fontSize: 11, color: C.muted }}>
                Keys and router config are managed via server env — mutation controls are disabled here.
              </span>
            )}
          </div>
        </Panel>

        {/* GAUGE ROW */}
        <Panel className="span7" title="Fleet health" right={
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: routableCount ? C.green : C.red }}>
            {routableCount}/{keys.length} routable
          </span>
        }>
          <div style={{ display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: 6 }}>
            <Gauge value={fleetPct} threshold={threshold} label="Fleet capacity used" sub={`${fmt(totalUsed)} tok`} />
            <Gauge value={active ? pct(active) : 0} threshold={threshold} label="Active key usage" sub={active ? active.label.slice(0, 14) : "none"} />
            <Gauge value={keys.length ? (routableCount / keys.length) * 100 : 0} threshold={50} label="Keys routable" sub={`${routableCount} of ${keys.length}`} />
          </div>
        </Panel>

        {/* ROUTING CONTROLS */}
        <Panel className="span5" title="Router config" right={
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.muted }}>
            auto-switch
            <button onClick={() => setAuto((a) => !a)} disabled={isLive} style={{ width: 38, height: 20, borderRadius: 999, border: `1px solid ${C.border}`, background: (isLive || auto) ? C.green : "#0A0B0D", position: "relative", padding: 0, opacity: isLive ? 0.5 : 1 }}>
              <span style={{ position: "absolute", top: 2, left: auto ? 19 : 2, width: 14, height: 14, borderRadius: 999, background: auto ? C.bg : C.muted, transition: "left .2s" }} />
            </button>
          </label>
        }>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ flex: "1 1 180px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: C.muted, marginBottom: 4 }}>
                <span>rotate before</span><span style={{ fontFamily: MONO, color: C.text }}>{threshold}%</span>
              </div>
              <input type="range" min="40" max="99" value={threshold} disabled={isLive} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: "100%", accentColor: C.green, opacity: isLive ? 0.5 : 1 }} />
            </div>
            <div style={{ flex: "1 1 160px" }}>
              <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 4 }}>strategy</div>
              <select value={strategy} disabled={isLive} onChange={(e) => setStrategy(e.target.value)} style={{ ...input, opacity: isLive ? 0.5 : 1 }}>
                <option value="lowest">Lowest usage first</option>
                <option value="round">Round-robin</option>
              </select>
            </div>
          </div>
          {issues.length > 0 && (
            <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
              {issues.map(({ k, s }) => (
                <div key={k.id} style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 11.5, color: C.muted, padding: "2px 0" }}>
                  <Shield size={11} color={STATUS[s].color} />
                  <span style={{ color: C.text, fontWeight: 600 }}>{k.label}</span>
                  <span style={{ fontFamily: MONO }}>{s === "error" ? ERROR_LABEL[k.errorType] : s === "exhausted" ? "quota spent" : `at ${pct(k).toFixed(0)}%`}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* MULTI-SERIES CHART */}
        <Panel className="span8" title="Tokens routed per key">
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <XAxis dataKey="t" tick={{ fill: C.muted, fontSize: 9.5, fontFamily: MONO }} axisLine={{ stroke: C.border }} tickLine={false} />
                <YAxis tick={{ fill: C.muted, fontSize: 9.5, fontFamily: MONO }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, fontFamily: MONO }} labelStyle={{ color: C.muted }} />
                <Legend wrapperStyle={{ fontSize: 10.5, fontFamily: SANS }}
                  formatter={(id) => keys.find((k) => k.id === id)?.label || id} />
                {keys.map((k) => (
                  <Line key={k.id} type="stepAfter" dataKey={k.id} stroke={keyColor[k.id]}
                    strokeWidth={1.8} dot={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* HEATMAP */}
        <Panel className="span4" title="Request intensity" right={<span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>last {HEAT_COLS} ticks</span>}>
          <Heatmap keys={keys} heat={heat} />
        </Panel>

        {/* KEYS */}
        <Panel className="span7" title={`Keys (${keys.length})`} right={
          isLive
            ? <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted }}>env-managed</span>
            : <button onClick={() => setModal({})} style={chip(C.green)}><Plus size={13} /> Add</button>
        }>
          <div className="kr-keys-grid">
            {keys.map((k) => (
              <KeyCard key={k.id} k={k} active={k.id === activeId} threshold={threshold}
                revealed={!!revealed[k.id]} onReveal={revealToggle} onToggle={toggleKey}
                onDelete={deleteKey} onInject={injectIssue} onFix={fixKey}
                onEdit={(kk) => setModal(kk)} color={keyColor[k.id]} readOnly={isLive} />
            ))}
            {keys.length === 0 && (
              <div style={{ textAlign: "center", color: C.muted, fontSize: 12.5, padding: 24, border: `1px dashed ${C.border}`, borderRadius: 4 }}>
                No keys. Add one to start routing.
              </div>
            )}
          </div>
        </Panel>

        {/* TERMINAL LOGS */}
        <Panel className="span5" title="Live logs">
          <Terminal log={log} />
        </Panel>

        <div className="span12" style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, padding: "0 2px" }}>
          <strong style={{ color: C.text }}>Security:</strong> demo holds mock keys in memory only. In production
          this dashboard polls the Key Router backend's <code style={{ fontFamily: MONO }}>/v1/status</code> endpoint
          (bearer-token auth, CORS allow-listed) — raw keys never reach the browser.
        </div>
      </div>

      {modal && <KeyModal initial={modal.id ? modal : null} onClose={() => setModal(null)} onSave={saveKey} />}
    </div>
  );
}

/* helpers */
const iconBtn = { background: "transparent", border: "none", color: C.muted, display: "grid", placeItems: "center", padding: 2 };
const input = { width: "100%", background: "#0A0B0D", border: `1px solid ${C.border}`, borderRadius: 4, padding: "9px 10px", color: C.text, fontSize: 13, fontFamily: SANS };
function chip(color) {
  return {
    display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600,
    fontFamily: SANS, color, background: `${color}16`, border: `1px solid ${color}44`,
    borderRadius: 4, padding: "6px 10px",
  };
}
