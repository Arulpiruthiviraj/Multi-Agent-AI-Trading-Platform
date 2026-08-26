/**
 * ==========================================================
 * Module: StrategyPerformancePanel
 *
 * Purpose:
 * "What quant strategies are actually working" (2026-08-25, market-open readiness follow-up).
 * Reads GET /api/v2/quant/strategy-performance, which exposes daily_strategy_performance - a
 * table CampaignTracker.ts has always populated (attributing every organic FILLED trade to the
 * quant strategy id that opened the position) but that had zero API route or UI consumer before
 * this pass. No new computation: this renders real, already-persisted per-strategy P&L/win-rate
 * data. Also includes a static "how the Java quant engine fits in" explainer - deliberately
 * describing the real, current, advisory-only architecture (CLAUDE.md "Java 26 Engine
 * Authority") rather than implying Java places or sizes trades, which it does not.
 * ==========================================================
 */
import React, { useEffect, useState } from "react";
import { Brain, TrendingUp, TrendingDown, ArrowRight } from "lucide-react";
import AwaitingSignal from "./shared/AwaitingSignal";

interface StrategyPerformanceRow {
  quantStrategyId: string;
  realizedPnl: number;
  unrealizedPnl: number;
  tradesCount: number;
  winsCount: number;
  lossesCount: number;
  lastActiveDate: string;
  winRatePct: number | null;
}

const DAY_OPTIONS = [7, 30, 90];

const PIPELINE_STAGES = [
  { label: "Java Quant Core", detail: "Regime (HMM), factors, volatility (GARCH), correlation — computed in quant-core-java" },
  { label: "Strategy Evaluation", detail: "Each of the 5 CORE strategies scores its own conditions against current market data" },
  { label: "Grouped Scores", detail: "Trend/momentum/volume/VWAP/market/sector scores blended per side (BUY vs SELL)" },
  { label: "Quant Advisory", detail: "Regime + volatility-adjusted confidence — advisory only, confidence discounted off-regime, never zeroed" },
  { label: "ChiefTrader Vote", detail: "One vote among many independent agents — still needs consensus + RiskEngine + OMS" },
];

function fmtDollars(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function StrategyPerformancePanel() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<StrategyPerformanceRow[]>([]);
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPipeline, setShowPipeline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/v2/quant/strategy-performance?days=${days}`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        if (!json.ok) { setAvailable(false); setReason(json.error || "Unknown error"); setLoading(false); return; }
        setAvailable(!!json.available);
        setReason(json.reason ?? null);
        setRows(Array.isArray(json.byStrategy) ? json.byStrategy : []);
        setLoading(false);
      })
      .catch(e => { if (!cancelled) { setAvailable(false); setReason(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [days]);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 flex flex-col gap-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-500/10 p-3 rounded border border-indigo-500/20 text-indigo-400">
            <Brain size={24} />
          </div>
          <div>
            <h3 className="text-xl font-bold text-white uppercase tracking-widest">Strategy Performance</h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              Real per-strategy P&amp;L attribution from organic FILLED trades — which quant strategies are actually working.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {DAY_OPTIONS.map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1 text-[10px] font-mono font-black rounded border transition-all ${days === d ? "bg-slate-700 border-slate-600 text-white" : "bg-[#111822] border-slate-800 text-slate-500 hover:text-slate-300"}`}
            >
              {d}D
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => setShowPipeline(v => !v)}
        className="text-left border border-slate-800 rounded-lg p-4 bg-[#111822] hover:border-slate-700 transition-colors"
      >
        <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-1">
          How the quant engine feeds a trade decision {showPipeline ? "(click to collapse)" : "(click to expand)"}
        </p>
        {showPipeline && (
          <div className="mt-3 flex flex-col md:flex-row items-stretch gap-2">
            {PIPELINE_STAGES.map((stage, i) => (
              <React.Fragment key={stage.label}>
                <div className="flex-1 border border-slate-800 rounded p-3 bg-[#0A0F16]">
                  <p className="text-[11px] font-bold text-white uppercase tracking-widest mb-1">{stage.label}</p>
                  <p className="text-[10px] text-slate-500 leading-relaxed">{stage.detail}</p>
                </div>
                {i < PIPELINE_STAGES.length - 1 && (
                  <div className="hidden md:flex items-center justify-center text-slate-700 shrink-0">
                    <ArrowRight size={16} />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
        {showPipeline && (
          <p className="text-[10px] text-slate-600 mt-3 italic">
            Advisory only — quant-core-java is isolated and never places, sizes, or authorizes a real order. A trade still requires ChiefTrader consensus (≥2 independent agents, 75% weighted confidence), all 24 RiskEngine gates, and OMS/broker execution.
          </p>
        )}
      </button>

      <div className="overflow-x-auto">
        {loading ? (
          <p className="py-8 text-center text-slate-500 text-sm font-mono">Loading strategy performance...</p>
        ) : !available ? (
          <AwaitingSignal reason={reason ?? "No strategy performance data available yet."} />
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-slate-500 text-sm font-mono">No attributed trades in the last {days} day(s).</p>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                <th className="pb-3 pl-2 font-medium">Strategy</th>
                <th className="pb-3 font-medium text-center">Trades</th>
                <th className="pb-3 font-medium text-center">Win Rate</th>
                <th className="pb-3 font-medium text-right">Realized P&amp;L</th>
                <th className="pb-3 font-medium text-right pr-2">Unrealized P&amp;L</th>
                <th className="pb-3 font-medium text-right pr-2">Last Active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.quantStrategyId} className="border-b border-slate-800/50">
                  <td className="py-3 pl-2 font-bold text-slate-200">{r.quantStrategyId}</td>
                  <td className="py-3 text-center font-mono text-slate-300">{r.tradesCount}</td>
                  <td className="py-3 text-center font-mono">
                    {r.winRatePct === null ? (
                      <span className="text-slate-600">no closed trades</span>
                    ) : (
                      <span className={r.winRatePct >= 50 ? "text-emerald-400" : "text-rose-400"}>{r.winRatePct}%</span>
                    )}
                  </td>
                  <td className={`py-3 text-right font-mono font-bold ${r.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    <span className="inline-flex items-center gap-1 justify-end">
                      {r.realizedPnl >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {fmtDollars(r.realizedPnl)}
                    </span>
                  </td>
                  <td className={`py-3 text-right pr-2 font-mono ${r.unrealizedPnl >= 0 ? "text-emerald-400/70" : "text-rose-400/70"}`}>
                    {fmtDollars(r.unrealizedPnl)}
                  </td>
                  <td className="py-3 text-right pr-2 font-mono text-[10px] text-slate-500">{r.lastActiveDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
