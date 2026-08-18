import React, { useState, useEffect, useRef, type ReactNode } from "react";
import { BrainCircuit, Activity, Database, Clock, AlertTriangle, Settings2, BarChart2, ActivitySquare, CheckCircle2 } from "lucide-react";
import { ContextualTooltip } from "./ContextualTooltip";

type KronosStatusPayload = {
  status?: string;
  version?: string;
  memoryUsage?: string | null;
  gpuUsage?: string | null;
  inferenceTime?: number | string | null;
  isAvailable?: boolean;
  serviceUrl?: string;
  error?: string;
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
  if (typeof value === "number") return !Number.isFinite(value) || value === 0;
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

export const KronosDashboard = () => {
  const [kronosStatus, setKronosStatus] = useState<KronosStatusPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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
      fetch("/api/v1/kronos/status", { signal: controller.signal })
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          return data as KronosStatusPayload;
        })
        .then((data) => {
          if (cancelled) return;
          setLoadError(null);
          setKronosStatus(data);
        })
        .catch((err: Error) => {
          if (cancelled || err?.name === 'AbortError') return;
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
  }, []);

  const probing = kronosStatus === null;
  const isUnavailable =
    probing ||
    kronosStatus?.isAvailable === false ||
    kronosStatus?.status === "UNAVAILABLE" ||
    (kronosStatus?.status || "").toLowerCase().includes("unavailable");

  const serviceUrl = kronosStatus?.serviceUrl || "http://127.0.0.1:8008";
  const versionDisplay = kronosStatus?.version || "unknown";
  const gpuDisplay = kronosStatus?.gpuUsage ?? "—";
  const memDisplay = kronosStatus?.memoryUsage ?? "—";
  const inferenceRaw = kronosStatus?.inferenceTime;
  const inferenceDisplay =
    inferenceRaw == null || inferenceRaw === 0 || inferenceRaw === "0"
      ? "—"
      : typeof inferenceRaw === "number"
        ? `${inferenceRaw} ms`
        : String(inferenceRaw);

  const healthWhen = `Becomes Ready after GET ${serviceUrl}/health returns ok (Chronos Python on LOCAL_AI_SERVICE_PORT, default 8008). Use npm run dev (not dev:server-only), wait for the first Hugging Face model load (~1 min), then this tab refreshes every 10s.`;

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
                forecasts.
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
              when="Not exposed by Chronos GET /health today. Stays unavailable until the Python service reports real GPU telemetry — Argus will not invent a percentage."
              className="text-sm font-mono text-slate-300"
            >
              {String(gpuDisplay)}
            </WhenAvailable>
          </div>
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
              <Database size={12} /> Memory Usage
            </div>
            <WhenAvailable
              title="Memory Usage"
              when="Not exposed by Chronos GET /health today. Stays unavailable until the Python service reports real process memory — Argus will not invent a figure."
              className="text-sm font-mono text-slate-300"
            >
              {String(memDisplay)}
            </WhenAvailable>
          </div>
          <div className="bg-[#111822] border border-slate-800 rounded p-4">
            <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
              <Clock size={12} /> Inference Time
            </div>
            <WhenAvailable
              title="Inference Time"
              when="Status API does not record /forecast latency yet (field stays empty). Becomes available only after measured inference latency is wired into getStatus — not fabricated from a guess."
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
              <WhenAvailable
                title="Forecast Horizon"
                when="Not wired to a live config/status field. Would show the horizon from a successful KronosForecastAgent /forecast call once that value is exposed to this UI."
                className="text-xs text-slate-300"
              >
                ---
              </WhenAvailable>
            </div>
            <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
              <span className="text-xs text-slate-400">Timeframes</span>
              <WhenAvailable
                title="Timeframes"
                when="Not wired to a live config/status field. Stays --- until the agent reports which bar timeframe it used for a real forecast."
                className="text-xs font-mono text-indigo-400"
              >
                ---
              </WhenAvailable>
            </div>
            <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
              <span className="text-xs text-slate-400">Confidence Threshold</span>
              <WhenAvailable
                title="Confidence Threshold"
                when="Not read from tradingSafety / status for this panel. Stays --- until a reviewed config value is surfaced here (no invented threshold)."
                className="text-xs font-mono text-emerald-400"
              >
                ---
              </WhenAvailable>
            </div>
            <div className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800">
              <span className="text-xs text-slate-400">Multi-Asset Batch Mode</span>
              <WhenAvailable
                title="Multi-Asset Batch Mode"
                when="Batch predict exists in KronosEngine but this UI does not read a live on/off flag. Stays --- until that flag is exposed by the status API."
                className="text-xs font-mono text-emerald-400 text-right uppercase"
              >
                ---
              </WhenAvailable>
            </div>
          </div>
        </div>

        <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
          <h2 className="text-sm font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
            <BarChart2 size={16} className="text-emerald-400" />
            Historical Performance
          </h2>
          <div className="space-y-4">
            {(
              [
                [
                  "Directional Accuracy",
                  "kronos_predictions.directional_accuracy is never scored today (schema column unused). Stays DATA_UNAVAILABLE until forecasts are scored against outcomes in DB — Argus will not invent accuracy.",
                ],
                [
                  "MAE",
                  "Mean absolute error is not computed for Kronos forecasts in this codebase. Stays DATA_UNAVAILABLE until a real scored series exists.",
                ],
                [
                  "RMSE",
                  "Root mean squared error is not computed for Kronos forecasts in this codebase. Stays DATA_UNAVAILABLE until a real scored series exists.",
                ],
                [
                  "MAPE",
                  "Mean absolute percentage error is not computed for Kronos forecasts in this codebase. Stays DATA_UNAVAILABLE until a real scored series exists.",
                ],
              ] as const
            ).map(([label, when]) => (
              <div
                key={label}
                className="flex justify-between items-center bg-[#111822] p-3 rounded border border-slate-800 gap-3"
              >
                <span className="text-xs text-slate-400">{label}</span>
                <WhenAvailable
                  title={label}
                  when={when}
                  className={`text-sm font-mono ${label === "Directional Accuracy" ? "text-emerald-400" : "text-slate-300"}`}
                >
                  DATA_UNAVAILABLE
                </WhenAvailable>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <h2 className="text-sm font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
          <ActivitySquare size={16} className="text-indigo-400" />
          Kronos Volatility & Price Forecast (ATR Bands)
        </h2>

        <div className="h-72 w-full mt-4 flex items-center justify-center border border-dashed border-slate-700 bg-[#111822] rounded">
          <WhenAvailable
            title="Volatility & Price Forecast chart"
            when="This chart has no backend series wired yet (empty client array). Becomes available only after a successful Chronos /forecast is stored and an API feeds median/low/high bands into this UI — not a fabricated ATR ribbon."
            className="text-sm text-slate-500 font-mono"
          >
            DATA_UNAVAILABLE
          </WhenAvailable>
        </div>
      </div>
    </div>
  );
};
