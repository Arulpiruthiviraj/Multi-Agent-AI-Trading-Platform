/**
 * ==========================================================
 * Module: QuantSignalsPanel
 *
 * Purpose:
 * Observability for the additive quant layer (RegimeEngine/MarketContext/StrategyEngine/
 * GroupedScores/QuantContradictionAnalyzer/BacktestEngine.runStrategyBacktest) - previously this
 * entire real, tested subsystem had no route or UI reading its persisted output at all. Reads
 * GET /api/v2/quant/assessments/:symbol (real per-symbol regime/strategy/score history, off by
 * default unless QUANT_ENGINE_ENABLED=true), GET/POST /api/v2/quant/strategy-backtests (real
 * per-strategy, per-regime backtest results), and GET /api/v2/quant/strategies (the 5 real
 * strategies). Every empty/unavailable state is honest (AwaitingSignal-style), never a fabricated
 * number - matches this codebase's own UI Truth Principle.
 * ==========================================================
 */
import React, { useEffect, useState } from "react";
import { Brain, TrendingUp, TrendingDown, Minus, PlayCircle, Loader2 } from "lucide-react";
import AwaitingSignal from "./shared/AwaitingSignal";

interface QuantStrategy {
  id: string;
  displayName: string;
  applicableRegimes: string[];
  typicalHoldingPeriod: string | null;
}

interface QuantAssessment {
  id: string;
  symbol: string;
  createdAt: string;
  regime: { regime: string; trendStrength: number; volatility: string; marketStructure: string; confidence: number };
  strategyEvaluations: { strategy: string; side: string; setupScore: number; confidence: number }[] | null;
  groupedScores: { BUY: { overallSetupScore: number }; SELL: { overallSetupScore: number } } | null;
  aiContradictionAnalysis: { available: boolean; aiAgreesWithSide: boolean | null; scenarioAnalysis: string } | null;
  emittedTradeIdea: boolean;
}

interface StrategyBacktestSummary {
  id: string;
  strategyId: string;
  symbol: string;
  status: string;
  errorMessage: string | null;
  finalEquity: number | null;
  totalTrades: number | null;
  winRatePct: number | null;
  profitFactor: number | null;
  sharpe: number | null;
  avgR: number | null;
  maxConsecutiveLosses: number | null;
  regimeBreakdown: Record<string, { count: number; winRatePct: number; expectancy: number }> | null;
  expectedValue: { expectedValueR: number } | null;
  kelly: { suggestedFraction: number; statisticallyJustified: boolean; reason: string } | null;
  createdAt: string;
}

const REGIME_COLOR: Record<string, string> = {
  BULLISH_TREND: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  BEARISH_TREND: "text-rose-400 border-rose-500/30 bg-rose-500/10",
  SIDEWAYS_RANGE: "text-slate-400 border-slate-600/30 bg-slate-700/20",
};

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 65 ? "bg-emerald-400" : value <= 35 ? "bg-rose-400" : "bg-slate-400";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-mono text-slate-500 w-28 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="text-[10px] font-mono text-slate-400 w-8 text-right">{value}</span>
    </div>
  );
}

export default function QuantSignalsPanel() {
  const [symbol, setSymbol] = useState("AAPL");
  const [assessments, setAssessments] = useState<QuantAssessment[]>([]);
  const [assessmentsAvailable, setAssessmentsAvailable] = useState(true);
  const [assessmentsReason, setAssessmentsReason] = useState<string | undefined>();
  const [loadingAssessments, setLoadingAssessments] = useState(false);

  const [strategies, setStrategies] = useState<QuantStrategy[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState("TREND_FOLLOWING");
  const [backtestSymbol, setBacktestSymbol] = useState("AAPL");
  const [startDate, setStartDate] = useState(() => new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]);
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [runs, setRuns] = useState<StrategyBacktestSummary[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v2/quant/strategies")
      .then(r => r.json())
      .then(json => {
        if (!json.ok) return;
        const core = json.strategies || [];
        const experimental = (json.experimentalStrategies || []).map((s: QuantStrategy) => ({
          ...s,
          displayName: `${s.displayName} [UNVALIDATED]`,
        }));
        setStrategies([...core, ...experimental]);
      })
      .catch(() => {});
  }, []);

  const loadAssessments = (sym: string) => {
    setLoadingAssessments(true);
    fetch(`/api/v2/quant/assessments/${encodeURIComponent(sym)}`)
      .then(r => r.json())
      .then(json => {
        if (json.ok) {
          setAssessmentsAvailable(json.available);
          setAssessmentsReason(json.reason);
          setAssessments(json.data || []);
        }
      })
      .catch(() => setAssessmentsAvailable(false))
      .finally(() => setLoadingAssessments(false));
  };

  const loadRuns = () => {
    fetch("/api/v2/quant/strategy-backtests")
      .then(r => r.json())
      .then(json => { if (json.ok) setRuns(json.data); })
      .catch(() => {});
  };

  useEffect(() => { loadAssessments(symbol); }, [symbol]);
  useEffect(() => { loadRuns(); }, []);

  const runBacktest = () => {
    setRunning(true);
    setRunError(null);
    fetch("/api/v2/quant/strategy-backtests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId: selectedStrategy, symbol: backtestSymbol, startDate, endDate }),
    })
      .then(r => r.json())
      .then(json => {
        if (!json.ok) { setRunError(json.error); return; }
        loadRuns();
      })
      .catch(e => setRunError(String(e)))
      .finally(() => setRunning(false));
  };

  const latest = assessments[0];

  return (
    <div className="animate-fade-in flex flex-col gap-6">
      {/* Real per-symbol regime/strategy/score history */}
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
          <div className="flex items-center gap-3">
            <div className="bg-violet-500/10 p-3 rounded border border-violet-500/20 text-violet-400">
              <Brain size={24} />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white uppercase tracking-widest">Quant Decision Layer</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Real regime/strategy/probabilistic scoring - off by default (QUANT_ENGINE_ENABLED).
              </p>
            </div>
          </div>
          <input
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => { if (e.key === "Enter") loadAssessments(symbol); }}
            placeholder="Symbol (e.g. AAPL)"
            className="bg-[#111822] border border-slate-800 rounded px-3 py-2 text-sm text-white font-mono w-40"
          />
        </div>

        {loadingAssessments ? (
          <div className="py-8 text-center text-slate-500 text-sm font-mono">Loading real quant assessments...</div>
        ) : !assessmentsAvailable || !latest ? (
          <AwaitingSignal reason={assessmentsReason || `No real quant assessments recorded yet for ${symbol}.`} />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-4">
              <div className={`px-3 py-1.5 rounded border text-xs font-mono font-bold tracking-wider ${REGIME_COLOR[latest.regime.regime] || "text-slate-400 border-slate-700"}`}>
                {latest.regime.regime.replace(/_/g, " ")}
              </div>
              <span className="text-[11px] text-slate-500 font-mono">trend strength {latest.regime.trendStrength} · volatility {latest.regime.volatility} · structure {latest.regime.marketStructure}</span>
              <span className="text-[11px] text-slate-600 font-mono ml-auto">as of {new Date(latest.createdAt).toLocaleString()}</span>
            </div>

            {latest.strategyEvaluations && latest.strategyEvaluations.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                      <th className="pb-2 font-medium">Strategy</th>
                      <th className="pb-2 font-medium text-center">Side</th>
                      <th className="pb-2 font-medium text-center">Setup Score</th>
                      <th className="pb-2 font-medium text-center">Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...latest.strategyEvaluations].sort((a, b) => b.setupScore - a.setupScore).map(s => (
                      <tr key={s.strategy} className="border-b border-slate-800/50">
                        <td className="py-2 text-slate-300 font-mono text-xs">{s.strategy}</td>
                        <td className="py-2 text-center">
                          {s.side === "BUY" ? <TrendingUp size={14} className="inline text-emerald-400" /> : <TrendingDown size={14} className="inline text-rose-400" />}
                        </td>
                        <td className="py-2 text-center font-mono text-xs text-slate-300">{s.setupScore}</td>
                        <td className="py-2 text-center font-mono text-xs text-slate-400">{s.confidence.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {latest.groupedScores && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 bg-[#111822] border border-slate-800/60 rounded p-4">
                <ScoreBar label="Overall (BUY)" value={latest.groupedScores.BUY.overallSetupScore} />
                <ScoreBar label="Overall (SELL)" value={latest.groupedScores.SELL.overallSetupScore} />
              </div>
            )}

            {latest.aiContradictionAnalysis?.available ? (
              <div className="bg-[#111822] border border-slate-800/60 rounded p-4 text-xs text-slate-400 leading-relaxed">
                <span className="text-[10px] font-mono uppercase tracking-wider text-violet-400 mr-2">AI Review</span>
                {latest.aiContradictionAnalysis.aiAgreesWithSide === true && <span className="text-emerald-400 font-mono text-[10px] mr-2">AGREES</span>}
                {latest.aiContradictionAnalysis.aiAgreesWithSide === false && <span className="text-rose-400 font-mono text-[10px] mr-2">DISAGREES</span>}
                {latest.aiContradictionAnalysis.aiAgreesWithSide === null && <span className="text-slate-500 font-mono text-[10px] mr-2">UNCERTAIN</span>}
                {latest.aiContradictionAnalysis.scenarioAnalysis}
              </div>
            ) : (
              <AwaitingSignal compact reason="No AI provider configured - qualitative review unavailable." />
            )}
          </div>
        )}
      </div>

      {/* Real per-strategy backtest launcher + results */}
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <h3 className="text-lg font-bold text-white uppercase tracking-widest mb-4">Real Per-Strategy Backtest</h3>
        <div className="flex flex-wrap items-end gap-3 mb-6">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-mono text-slate-500 uppercase">Strategy</label>
            <select value={selectedStrategy} onChange={e => setSelectedStrategy(e.target.value)} className="bg-[#111822] border border-slate-800 rounded px-3 py-2 text-sm text-white font-mono">
              {strategies.map(s => <option key={s.id} value={s.id}>{s.displayName}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-mono text-slate-500 uppercase">Symbol</label>
            <input value={backtestSymbol} onChange={e => setBacktestSymbol(e.target.value.toUpperCase())} className="bg-[#111822] border border-slate-800 rounded px-3 py-2 text-sm text-white font-mono w-28" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-mono text-slate-500 uppercase">Start</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="bg-[#111822] border border-slate-800 rounded px-3 py-2 text-sm text-white font-mono" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-mono text-slate-500 uppercase">End</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="bg-[#111822] border border-slate-800 rounded px-3 py-2 text-sm text-white font-mono" />
          </div>
          <button
            onClick={runBacktest}
            disabled={running}
            className="flex items-center gap-2 bg-violet-500/10 border border-violet-500/30 text-violet-400 hover:bg-violet-500/20 disabled:opacity-50 px-4 py-2 rounded text-xs font-mono font-bold tracking-wider"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
            RUN REAL BACKTEST
          </button>
        </div>
        {runError && <div className="text-rose-400 text-xs font-mono mb-4">{runError}</div>}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                <th className="pb-2 font-medium">Strategy / Symbol</th>
                <th className="pb-2 font-medium text-center">Status</th>
                <th className="pb-2 font-medium text-center">Trades</th>
                <th className="pb-2 font-medium text-center">Win Rate</th>
                <th className="pb-2 font-medium text-center">Avg R</th>
                <th className="pb-2 font-medium text-center">Kelly</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr><td colSpan={6} className="py-6 text-center text-slate-500 text-sm font-mono">No real backtest runs yet.</td></tr>
              ) : runs.map(r => (
                <tr key={r.id} className="border-b border-slate-800/50">
                  <td className="py-2 text-slate-300 font-mono text-xs">{r.strategyId} / {r.symbol}</td>
                  <td className="py-2 text-center font-mono text-[10px]">
                    <span className={r.status === "COMPLETED" ? "text-emerald-400" : r.status === "FAILED" ? "text-rose-400" : "text-slate-500"}>{r.status}</span>
                  </td>
                  <td className="py-2 text-center font-mono text-xs text-slate-400">{r.totalTrades ?? <Minus size={12} className="inline text-slate-600" />}</td>
                  <td className="py-2 text-center font-mono text-xs text-slate-400">{r.winRatePct !== null ? `${r.winRatePct}%` : "--"}</td>
                  <td className="py-2 text-center font-mono text-xs text-slate-400">{r.avgR !== null ? r.avgR.toFixed(2) : "--"}</td>
                  <td className="py-2 text-center font-mono text-[10px] text-slate-400">
                    {r.kelly?.statisticallyJustified ? `${(r.kelly.suggestedFraction * 100).toFixed(1)}%` : <span className="text-slate-600">insufficient sample</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
