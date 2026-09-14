/**
 * ==========================================================
 * Module: OpportunitySnapshotPanel
 *
 * Purpose:
 * ARGUS MASTER TRANSFORMATION MANDATE Part 8/9/24 (2026-09-13/14) - real, evidence-ranked
 * cross-sectional opportunity view, reading GET /api/v2/observability/opportunity-snapshot
 * (opportunitySnapshot.ts). Deliberately distinct from this tab's existing "Autonomous
 * Opportunity Feed" above (which lists raw recent agent_predictions rows): this panel composes
 * real historical edge (win rate, Wilson lower bound, evidence classification), real multi-horizon
 * forward returns, real strategy metadata (tier/family/lifecycle), the real Part 7 forecast
 * (expected return / probability of profit / net expected return), and real strategy-diversity
 * evidence (effective independent count / family count, Part 9) - ranked by real evidence quality,
 * never a fabricated composite score. OBSERVED/MEASURED (historical edge) is visually distinguished
 * from MODEL FORECAST (the Part 7 projection) per the mandate's own Frontend Rule - never
 * conflated, and every UNKNOWN/absent field renders as an honest label, never a placeholder number.
 * ==========================================================
 */
import React, { useEffect, useState } from 'react';
import { Crosshair } from 'lucide-react';
import AwaitingSignal from './shared/AwaitingSignal';

interface OpportunitySnapshotRow {
  traceId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  strategyId: string | null;
  generatedAt: string;
  ideaConfidence: number;
  strategyTier: 'CORE' | 'EXPERIMENTAL' | 'JAVA_RESEARCH' | null;
  strategyFamily: string | null;
  strategyLifecycleStatus: string | null;
  historicalEdge: {
    variant: 'EV_BACKED' | 'COLD_START_BOOTSTRAP';
    rawN: number;
    effectiveN: number;
    winRate: number | null;
    wilsonLower: number | null;
    evidenceClassification: 'INSUFFICIENT_EVIDENCE' | 'NO_EDGE' | 'EDGE_SUPPORTED' | 'EDGE_DISPROVEN';
  } | null;
  alreadyHeld: boolean;
  modelForecast: {
    forecastId: string;
    status: string;
    expectedReturn: number | null;
    probabilityOfProfit: number | null;
    netExpectedReturn: number | null;
    sampleSize: number;
    strategyCount: number | null;
    familyCount: number | null;
    effectiveIndependentCount: number | null;
  } | null;
}

const EVIDENCE_COLOR: Record<string, string> = {
  EDGE_SUPPORTED: 'text-emerald-400 bg-emerald-900/30',
  NO_EDGE: 'text-slate-400 bg-slate-800/50',
  INSUFFICIENT_EVIDENCE: 'text-amber-400 bg-amber-900/30',
  EDGE_DISPROVEN: 'text-rose-400 bg-rose-900/30',
};

export default function OpportunitySnapshotPanel() {
  const [rows, setRows] = useState<OpportunitySnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v2/observability/opportunity-snapshot')
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
        <div className="bg-cyan-500/10 p-3 rounded border border-cyan-500/20 text-cyan-400">
          <Crosshair size={24} />
        </div>
        <div>
          <h3 className="text-xl font-bold text-white uppercase tracking-widest">Real Opportunity Snapshot</h3>
          <p className="text-slate-400 text-sm leading-relaxed">
            Evidence-ranked, never a fabricated score. OBSERVED (real historical edge) is shown
            separately from MODEL FORECAST (Part 7's statistical projection) - both null/UNKNOWN
            when real evidence does not yet exist.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        {loading ? (
          <p className="py-8 text-center text-slate-500 text-sm font-mono">Loading real opportunity data...</p>
        ) : error ? (
          <AwaitingSignal reason={error} />
        ) : rows.length === 0 ? (
          <AwaitingSignal reason="No directional QuantEngine idea with a real strategy_id exists yet in this window - not fabricated." />
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                <th className="pb-3 pl-2 font-medium">Symbol</th>
                <th className="pb-3 font-medium">Side</th>
                <th className="pb-3 font-medium">Strategy</th>
                <th className="pb-3 font-medium text-center">Tier</th>
                <th className="pb-3 font-medium text-center">Evidence (OBSERVED)</th>
                <th className="pb-3 font-medium text-right">Wilson Lo</th>
                <th className="pb-3 font-medium text-right">Forecast (MODEL)</th>
                <th className="pb-3 font-medium text-center">Eff. Indep (fam)</th>
                <th className="pb-3 font-medium text-center pr-2">Held</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const f = r.modelForecast;
                const forecastLabel = !f
                  ? 'NO_FORECAST'
                  : f.status !== 'VALID'
                    ? f.status
                    : `${((f.expectedReturn ?? 0) * 100).toFixed(2)}% / ${((f.probabilityOfProfit ?? 0) * 100).toFixed(0)}%`;
                const diversityLabel = !f || f.effectiveIndependentCount === null
                  ? 'UNKNOWN'
                  : `${f.effectiveIndependentCount.toFixed(1)} (${f.familyCount ?? '?'})`;
                return (
                  <tr key={`${r.traceId}-${i}`} className="border-b border-slate-800/50">
                    <td className="py-3 pl-2 font-bold text-slate-200">{r.symbol}</td>
                    <td className={`py-3 font-mono font-bold ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td>
                    <td className="py-3 font-mono text-[10px] text-slate-400">{r.strategyId ?? '(none)'}</td>
                    <td className="py-3 text-center font-mono text-[10px] text-slate-300">{r.strategyTier ?? '-'}</td>
                    <td className="py-3 text-center">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono ${EVIDENCE_COLOR[r.historicalEdge?.evidenceClassification ?? 'INSUFFICIENT_EVIDENCE']}`}>
                        {r.historicalEdge?.evidenceClassification ?? 'INSUFFICIENT_EVIDENCE'}
                      </span>
                    </td>
                    <td className="py-3 text-right font-mono text-slate-300">
                      {r.historicalEdge?.wilsonLower !== null && r.historicalEdge?.wilsonLower !== undefined ? r.historicalEdge.wilsonLower.toFixed(3) : 'N/A'}
                    </td>
                    <td className="py-3 text-right font-mono text-slate-300">{forecastLabel}</td>
                    <td className="py-3 text-center font-mono text-[10px] text-slate-400">{diversityLabel}</td>
                    <td className="py-3 text-center pr-2 font-mono text-[10px]">{r.alreadyHeld ? <span className="text-amber-400">YES</span> : <span className="text-slate-600">no</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
