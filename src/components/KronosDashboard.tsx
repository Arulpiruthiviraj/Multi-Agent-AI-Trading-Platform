import React, { useState, useEffect, useRef, type ReactNode } from "react";
import { BrainCircuit, Activity, Database, Clock, AlertTriangle, Settings2, BarChart2, ActivitySquare, CheckCircle2 } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { ContextualTooltip } from "./ContextualTooltip";

type KronosStatusPayload = {
  status?: string;
  version?: string;
  memoryUsage?: string | null;
  gpuUsage?: string | null;
  inferenceTime?: number | string | null;
  /** Alias of inferenceTime / Python lastInferenceMs — prefer when present. */
  latencyMs?: number | string | null;
  lastInferenceMs?: number | string | null;
  device?: string | null;
  isAvailable?: boolean;
  serviceUrl?: string;
  error?: string;
  forecastHorizon?: number | null;
  timeframe?: string | null;
  confidenceThreshold?: number | null;
  multiAssetBatchMode?: boolean | null;
};

type KronosMetricsPayload = {
  directionalAccuracy: number | null;
  mae: number | null;
  rmse: number | null;
  mape: number | null;
  sampleSize: number;
  source: string;
  unavailableReason: string | null;
};

type KronosForecastPayload = {
  symbol: string;
  available: boolean;
  prediction: string | null;
  confidence: number | null;
  expectedMove: string | null;
  volatility: string | null;
  support: number | null;
  resistance: number | null;
  timeframe: string | null;
  forecastHorizon: number | null;
  timestamp: string | null;
  model: string | null;
  series: { step: number; median: number; low: number; high: number }[];
  unavailableReason: string | null;
};

/** Hover hint for empty / placeholder Kronos fields — explains when (or if) the value can appear. */
function WhenAvailable({
  title,
  when,
  children,
  className = "",
}: {
  title: string;
  when: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ContextualTooltip title={title} content={when} quiet>
      <span className={`cursor-help border-b border-dotted border-slate-600 ${className}`.trim()}>
        {children}
      </span>
    </ContextualTooltip>
  );
}

function isBlankMetric(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "number") return !Number.isFinite(value);
  const s = String(value).trim();
  return (
    s === "" ||
    s === "-" ||
    s === "—" ||
    s === "--" ||
    s === "---" ||
    s === "unknown" ||
    s.toUpperCase() === "DATA_UNAVAILABLE"
  );
}

function formatPct(n: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "DATA_UNAVAILABLE";
  return `${(n * 100).toFixed(digits)}%`;
}

function formatNum(n: number | null, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return "DATA_UNAVAILABLE";
  return n.toFixed(digits);
}

function hardwareDisplay(value: string | null | undefined, fallback: string): string {
  if (value == null || String(value).trim() === "" || value === "--" || value === "—") return fallback;
  return String(value);
}

export const KronosDashboard = () => {
  const [kronosStatus, setKronosStatus] = useState<KronosStatusPayload | null>(null);
  const [metrics, setMetrics] = useState<KronosMetricsPayload | null>(null);
  const [forecast, setForecast] = useState<KronosForecastPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [symbolFilter, setSymbolFilter] = useState("");

  // Real perf fix (2026-08-18): 10s poll with no cancellation. Kronos's own status endpoint can
  // hang when the local Chronos service is unavailable - exactly the case where a slow response
  // needs its stale request cancelled, not left to pile up alongside the next tick's.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const q = symbolFilter.trim() ? `?symbol=${encodeURIComponent(symbolFilter.trim().toUpperCase())}` : "";
      Promise.all([
        fetch("/api/v1/kronos/status", { signal: controller.signal }).then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          return data as KronosStatusPayload;
        }),
        fetch("/api/v1/kronos/metrics", { signal: controller.signal }).then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          return data as KronosMetricsPayload;
        }),
        fetch(`/api/v1/kronos/forecast${q}`, { signal: controller.signal }).then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          return data as KronosForecastPayload;
        }),
      ])
        .then(([status, hist, fc]) => {
          if (cancelled) return;
          setLoadError(null);
          setKronosStatus(status);
          setMetrics(hist);
          setForecast(fc);
        })
        .catch((err: Error) => {
          if (cancelled || err?.name === "AbortError") return;
          setLoadError(err.message || "status fetch failed");
          setKronosStatus({ status: "UNAVAILABLE", isAvailable: false });
        });
    };
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [symbolFilter]);

  const probing = kronosStatus === null;
  const isUnavailable =
    probing ||
    kronosStatus?.isAvailable === false ||
    kronosStatus?.status === "UNAVAILABLE" ||
    (kronosStatus?.status || "").toLowerCase().includes("unavailable");

  const serviceUrl = kronosStatus?.serviceUrl || "http://127.0.0.1:8008";
  const versionDisplay = kronosStatus?.version || "unknown";
  const hwFallback = "N/A (CPU/MPS)";
  const gpuDisplay = hardwareDisplay(kronosStatus?.gpuUsage, hwFallback);
  const memDisplay = hardwareDisplay(kronosStatus?.memoryUsage, hwFallback);
  const inferenceRaw =
    kronosStatus?.latencyMs ?? kronosStatus?.lastInferenceMs ?? kronosStatus?.inferenceTime;
  const inferenceDisplay =
    inferenceRaw == null || inferenceRaw === 0 || inferenceRaw === "0"
      ? isUnavailable
        ? "—"
        : "N/A (awaiting /forecast)"
      : typeof inferenceRaw === "number"
        ? `${inferenceRaw} ms`
        : String(inferenceRaw);

  const healthWhen = `Becomes Ready after GET ${serviceUrl}/health returns ok (Chronos Python on LOCAL_AI_SERVICE_PORT, default 8008). Use npm run dev (not dev:server-only), wait for the first Hugging Face model load (~1 min), then this tab refreshes every 10s.`;

  const metricRows: { label: string; value: string; when: string }[] = [
    {
      label: "Directional Accuracy",
      value: metrics?.directionalAccuracy != null ? formatPct(metrics.directionalAccuracy) : "DATA_UNAVAILABLE",
      when:
        metrics?.unavailableReason ||
        `WIN/(WIN+LOSS) over ${metrics?.sampleSize ?? 0} scored Kronos prediction_outcomes rows.`,
    },
    {
      label: "MAE",
      value: metrics?.mae != null ? formatNum(metrics.mae) : "DATA_UNAVAILABLE",
      when:
        metrics?.mae != null
          ? `Mean absolute price error vs actualPrice across ${metrics.sampleSize} scored forecasts.`
          : metrics?.unavailableReason ||
            "Mean absolute price error needs scored Kronos prediction_outcomes with a predicted trajectory.",
    },
    {
      label: "RMSE",
      value: metrics?.rmse != null ? formatNum(metrics.rmse) : "DATA_UNAVAILABLE",
      when:
        metrics?.rmse != null
          ? `Root mean squared price error across ${metrics.sampleSize} scored forecasts.`
          : metrics?.unavailableReason || "RMSE needs scored Kronos prediction_outcomes with predicted prices.",
    },
    {
      label: "MAPE",
      value: metrics?.mape != null ? `${metrics.mape.toFixed(2)}%` : "DATA_UNAVAILABLE",
      when:
        metrics?.mape != null
          ? `Mean absolute percentage error across ${metrics.sampleSize} scored forecasts.`
          : metrics?.unavailableReason || "MAPE needs scored Kronos prediction_outcomes with predicted prices.",
    },
  ];

  const chartAvailable = Boolean(forecast?.available && forecast.series.length > 0);

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <h2 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800 pb-4 mb-4">
          <BrainCircuit size={18} className="text-indigo-400" />
          Kronos Local Inference Engine
        </h2>

        <div className="mb-4 flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-400">
          <span className="uppercase tracking-wider text-slate-500">Service</span>
          <WhenAvailable title="Chronos service URL" when={healthWhen}>
            <code className="text-indigo-300">{serviceUrl}</code>
          </WhenAvailable>
          <span
            className={`px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider ${
              probing
                ? "border-slate-600 text-slate-400"
                : isUnavailable
                  ? "border-rose-500/40 text-rose-400 bg-rose-500/10"
                  : "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
            }`}
          >
            {probing ? "Probing…" : isUnavailable ? "Unavailable" : "Ready"}
          </span>
          {kronosStatus?.device ? (
            <span className="text-slate-500">device={kronosStatus.device}</span>
          ) : null}
        </div>

        {isUnavailable ? (
          <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded text-rose-400 flex items-start gap-3">
            <AlertTriangle className="shrink-0 mt-0.5" size={16} />
            <div>
              <p className="font-medium text-sm">Warning: KRONOS_UNAVAILABLE</p>
              <p className="text-xs text-rose-400/80 mt-1">
                Nothing is answering{" "}
                <code className="text-[10px]">GET {serviceUrl}/health</code>. That Python process is
                Chronos-T5-mini + FinBERT — not a second Node engine.{" "}
                <code className="text-[10px]">npm run dev</code> starts it; wait for the first model
                load (can take a minute), then leave this tab open (auto-refresh every 10s). If it
                never comes up: install Python 3.10+, run{" "}
                <code className="text-[10px]">npm run setup:ai</code>, then restart.{" "}
                <code className="text-[10px]">npm run dev:server-only</code> does not start Chronos.
                Trading continues on Technical / Macro / Fundamental / News. Kronos does not invent
                forecasts or emit BUY/SELL ideas while down.
                {loadError ? (
                  <span className="block mt-1 text-rose-300/70">Status API: {loadError}</span>
                ) : null}
              </p>
            </div>
          </div>
        ) : (
          <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded text-emerald-400 flex items-start gap-3">
            <CheckCircle2 className="shrink-0 mt-0.5" size={16} />
            <div>
              <p className="font-medium text-sm">Status: {kronosStatus?.status || "Ready"}</p>
              <p className="text-xs text-emerald-400/70 mt-1 font-mono">
                Health ok at {serviceUrl} · model {versionDisplay}
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-6">
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
              <Database size={12} /> Model Version
            </div>
            {isBlankMetric(versionDisplay) ? (
              <WhenAvailable
                title="Model Version"
                when={`Shows the model id from GET ${serviceUrl}/health (e.g. amazon/chronos-t5-mini) after Chronos is Ready. Stays unknown while /health fails or is still loading.`}
                className="text-sm font-mono text-slate-300"
              >
                {versionDisplay}
              </WhenAvailable>
            ) : (
              <div className="text-sm font-mono text-slate-300">{versionDisplay}</div>
            )}
          </div>
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
              <Activity size={12} /> GPU Usage
            </div>
            <WhenAvailable
              title="GPU Usage"
              when="From Chronos GET /health device field. CPU/MPS hosts report N/A (CPU/MPS) — Argus will not invent a GPU percentage."
              className="text-sm font-mono text-slate-300"
            >
              {gpuDisplay}
            </WhenAvailable>
          </div>
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
              <Database size={12} /> Memory Usage
            </div>
            <WhenAvailable
              title="Memory Usage"
              when="From Chronos GET /health memoryUsage (process RSS when available). CPU/MPS shows N/A (CPU/MPS) rather than a fake GPU figure."
              className="text-sm font-mono text-slate-300"
            >
              {memDisplay}
            </WhenAvailable>
          </div>
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
              <Clock size={12} /> Inference Time
            </div>
            <WhenAvailable
              title="Inference Time"
              when="Last measured Chronos /forecast latency (Python latencyMs or Node round-trip). Stays N/A until a real forecast completes — never fabricated."
              className="text-sm font-mono text-slate-300"
            >
              {inferenceDisplay}
            </WhenAvailable>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
          <h2 className="text-sm font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
            <Settings2 size={16} className="text-slate-400" />
            Engine Configuration
          </h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
              <span className="text-xs text-slate-400">Forecast Horizon</span>
              <span className="text-xs text-slate-300 font-mono">
                {kronosStatus?.forecastHorizon != null ? `${kronosStatus.forecastHorizon} steps` : "---"}
              </span>
            </div>
            <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
              <span className="text-xs text-slate-400">Timeframes</span>
              <span className="text-xs font-mono text-indigo-400">{kronosStatus?.timeframe || "---"}</span>
            </div>
            <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
              <span className="text-xs text-slate-400">Neutral Band</span>
              <span className="text-xs font-mono text-emerald-400">
                {kronosStatus?.confidenceThreshold != null
                  ? `${(kronosStatus.confidenceThreshold * 100).toFixed(2)}%`
                  : "---"}
              </span>
            </div>
            <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
              <span className="text-xs text-slate-400">Multi-Asset Batch Mode</span>
              <span className="text-xs font-mono text-emerald-400 text-right uppercase">
                {kronosStatus?.multiAssetBatchMode === true ? "ON" : kronosStatus?.multiAssetBatchMode === false ? "OFF" : "---"}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
          <h2 className="text-sm font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
            <BarChart2 size={16} className="text-emerald-400" />
            Historical Performance
            {metrics?.sampleSize ? (
              <span className="ml-auto text-[10px] font-mono text-slate-500">n={metrics.sampleSize}</span>
            ) : null}
          </h2>
          <div className="space-y-4">
            {metricRows.map(({ label, value, when }) => (
              <div
                key={label}
                className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800 gap-3"
              >
                <span className="text-xs text-slate-400">{label}</span>
                {value === "DATA_UNAVAILABLE" ? (
                  <WhenAvailable
                    title={label}
                    when={when}
                    className={`text-sm font-mono ${label === "Directional Accuracy" ? "text-emerald-400" : "text-slate-300"}`}
                  >
                    DATA_UNAVAILABLE
                  </WhenAvailable>
                ) : (
                  <ContextualTooltip title={label} content={when} quiet>
                    <span
                      className={`text-sm font-mono cursor-help ${label === "Directional Accuracy" ? "text-emerald-400" : "text-slate-300"}`}
                    >
                      {value}
                    </span>
                  </ContextualTooltip>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 pb-4 mb-4">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <ActivitySquare size={16} className="text-indigo-400" />
            Kronos Volatility & Price Forecast (ATR Bands)
          </h2>
          <label className="ml-auto flex items-center gap-2 text-[10px] font-mono text-slate-500">
            Symbol
            <input
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value.toUpperCase())}
              placeholder="latest"
              className="bg-[#111822] border border-slate-700 rounded px-2 py-1 text-slate-300 w-24 uppercase"
            />
          </label>
        </div>

        {chartAvailable ? (
          <div className="h-72 w-full mt-2">
            <div className="mb-2 flex flex-wrap gap-3 text-[10px] font-mono text-slate-500">
              <span>{forecast!.symbol}</span>
              <span>{forecast!.prediction}</span>
              {forecast!.confidence != null ? <span>conf {(forecast!.confidence * 100).toFixed(1)}%</span> : null}
              {forecast!.expectedMove ? <span>move {forecast!.expectedMove}</span> : null}
              {forecast!.timestamp ? <span>{forecast!.timestamp}</span> : null}
            </div>
            <ResponsiveContainer width="100%" height="90%">
              <AreaChart data={forecast!.series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="step" stroke="#64748b" tick={{ fontSize: 10 }} />
                <YAxis stroke="#64748b" tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
                <Tooltip
                  contentStyle={{ background: "#111822", border: "1px solid #1e293b", fontSize: 11 }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Area type="monotone" dataKey="high" name="High (p90)" stroke="#6366f1" fill="#6366f133" />
                <Area type="monotone" dataKey="median" name="Median" stroke="#34d399" fill="#34d39922" />
                <Area type="monotone" dataKey="low" name="Low (p10)" stroke="#f43f5e" fill="#f43f5e22" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-72 w-full mt-4 flex items-center justify-center border border-dashed border-slate-700 bg-[#111822] rounded">
            <WhenAvailable
              title="Volatility & Price Forecast chart"
              when={
                forecast?.unavailableReason ||
                "Becomes available after a successful Chronos /forecast is stored in kronos_predictions (or agent_predictions trajectory). Chronos down → honest unavailable — no fabricated ATR ribbon."
              }
              className="text-sm text-slate-500 font-mono"
            >
              DATA_UNAVAILABLE
            </WhenAvailable>
          </div>
        )}
      </div>
    </div>
  );
};
