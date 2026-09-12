/**
 * ==========================================================
 * Module: MultiHorizonOutcomesPanel
 *
 * Purpose:
 * Research Memory Platform Phase 2 (2026-09-12) - real mean forward return / positive-return rate
 * per (agent, strategy, horizon), from GET /api/v2/observability/multi-horizon-outcomes. Reads
 * prediction_outcome_horizons (MultiHorizonOutcomeEvaluator.ts), a real, additive telemetry stream
 * deliberately separate from AgentEvaluationDashboard's single, live weight-learning-relevant
 * grading horizon above it in this same tab - this answers "how did the same real signal look at
 * +1/+5/+20/+60 bars," never a second win-rate claim competing with the one that feeds
 * agent_performance_stats.currentWeight.
 * ==========================================================
 */
import React, { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import AwaitingSignal from './shared/AwaitingSignal';

interface MultiHorizonSummaryRow {
  agentName: string;
  strategyId: string | null;
  horizonLabel: string;
  horizonBars: number;
  n: number;
  meanForwardReturn: number;
  positiveReturnRate: number;
}

export default function MultiHorizonOutcomesPanel() {
  const [rows, setRows] = useState<MultiHorizonSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v2/observability/multi-horizon-outcomes')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.ok) { setError(json.error || 'Unknown error'); setLoading(false); return; }
        setRows(Array.isArray(json.rows) ? json.rows : []);
        setLoading(false);
      })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 flex flex-col gap-4 mt-6">
      <div className="flex items-center gap-3">
        <div className="bg-indigo-500/10 p-3 rounded border border-indigo-500/20 text-indigo-400">
          <Layers size={24} />
        </div>
        <div>
          <h3 className="text-xl font-bold text-white uppercase tracking-widest">Multi-Horizon Forward Outcomes</h3>
          <p className="text-slate-400 text-sm leading-relaxed">
            Real forward return at +1/+5/+20/+60 bars per agent/strategy - separate from the single
            resolved-horizon grade that drives agent weight learning above.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        {loading ? (
          <p className="py-8 text-center text-slate-500 text-sm font-mono">Loading real multi-horizon outcome data...</p>
        ) : error ? (
          <AwaitingSignal reason={error} />
        ) : rows.length === 0 ? (
          <AwaitingSignal reason="No multi-horizon outcomes recorded yet - the background evaluator grades predictions once enough real bars have elapsed." />
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                <th className="pb-3 pl-2 font-medium">Agent</th>
                <th className="pb-3 font-medium">Strategy</th>
                <th className="pb-3 font-medium text-center">Horizon</th>
                <th className="pb-3 font-medium text-center">N</th>
                <th className="pb-3 font-medium text-right">Mean Fwd Return</th>
                <th className="pb-3 font-medium text-right pr-2">Positive Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.agentName}-${r.strategyId ?? 'overall'}-${r.horizonLabel}-${i}`} className="border-b border-slate-800/50">
                  <td className="py-3 pl-2 font-bold text-slate-200">{r.agentName}</td>
                  <td className="py-3 font-mono text-[10px] text-slate-400">{r.strategyId ?? '(overall)'}</td>
                  <td className="py-3 text-center font-mono text-[10px] text-slate-300">{r.horizonLabel}</td>
                  <td className="py-3 text-center font-mono text-slate-300">{r.n}</td>
                  <td className={`py-3 text-right font-mono font-bold ${r.meanForwardReturn >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {(r.meanForwardReturn * 100).toFixed(3)}%
                  </td>
                  <td className="py-3 text-right pr-2 font-mono text-slate-300">{(r.positiveReturnRate * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
