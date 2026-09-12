/**
 * ==========================================================
 * Module: PortfolioCorrelationPanel
 *
 * Purpose:
 * Research Memory / Institutional Platform follow-up (2026-09-11) - the account's REAL current
 * open-position correlation/diversification snapshot. Fetches GET /api/v2/portfolio/correlation,
 * which wires the already-existing, already-safe runCorrelationResearch() (same real Pearson
 * daily-return correlation RiskEngine gate #20/correlation_exposure already relies on) to the
 * account's actual real holdings for the first time - previously that research function was only
 * reachable with a caller-supplied symbol list, never auto-wired to a real portfolio. A pair
 * without enough overlapping real daily closes (tradingSafety.correlationMinOverlap + 1) renders
 * as AWAITING SIGNAL, never a fabricated coefficient - same honesty convention as
 * StrategySynergyMatrix.tsx, whose matrix-rendering approach this mirrors.
 * ==========================================================
 */
import React, { useEffect, useRef, useState } from 'react';
import { GitBranch } from 'lucide-react';
import AwaitingSignal from './shared/AwaitingSignal';

interface CorrelationPair {
  symbolA: string;
  symbolB: string;
  correlation: number | null;
}

interface CorrelationCluster {
  symbols: string[];
  averageIntraClusterCorrelation: number;
}

interface CorrelationAnalysis {
  pairs: CorrelationPair[];
  clusters: CorrelationCluster[];
  diversificationScore: number | null;
  clusterThreshold: number;
}

interface PortfolioCorrelationResponse {
  ok: boolean;
  available: boolean;
  reason?: string;
  data: CorrelationAnalysis | null;
}

const getColorForCorrelation = (val: number): string => {
  if (val >= 0.8) return 'bg-emerald-500/90 text-white';
  if (val >= 0.5) return 'bg-emerald-500/50 text-white';
  if (val >= 0.2) return 'bg-emerald-500/20 text-emerald-200';
  if (val > -0.2 && val < 0.2) return 'bg-slate-800 text-slate-400';
  if (val <= -0.8) return 'bg-rose-500/90 text-white';
  if (val <= -0.5) return 'bg-rose-500/50 text-white';
  return 'bg-rose-500/20 text-rose-200';
};

const PortfolioCorrelationPanel = () => {
  const [resp, setResp] = useState<PortfolioCorrelationResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Same abort-before-refetch idiom as StrategySynergyMatrix.tsx / AgentEvaluationDashboard.tsx
  // (this codebase's established fix for request pileup across independently polling panels).
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      fetch('/api/v2/portfolio/correlation', { signal: controller.signal })
        .then((r) => r.json())
        .then((json) => {
          if (!cancelled && json.ok) {
            setResp(json);
            setLoading(false);
          }
        })
        .catch((e) => { if (!cancelled && e?.name !== 'AbortError') setLoading(false); });
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); abortRef.current?.abort(); };
  }, []);

  const symbols = React.useMemo(() => {
    if (!resp?.data) return [];
    const set = new Set<string>();
    for (const p of resp.data.pairs) { set.add(p.symbolA); set.add(p.symbolB); }
    return Array.from(set).sort();
  }, [resp]);

  const matrixValue = (a: string, b: string): { val: number | null; found: boolean } => {
    if (a === b) return { val: 1, found: true };
    const pair = resp?.data?.pairs.find(
      (p) => (p.symbolA === a && p.symbolB === b) || (p.symbolA === b && p.symbolB === a),
    );
    return pair ? { val: pair.correlation, found: true } : { val: null, found: false };
  };

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 lg:p-6 shadow-md relative overflow-hidden group hover:border-indigo-500/30 transition-all duration-300 w-full mt-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
          <GitBranch size={16} className="text-indigo-400" />
          Portfolio Correlation &amp; Diversification
        </h3>
        {resp?.data && (
          <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest bg-slate-800/50 px-2 py-1 rounded border border-slate-700/50">
            {resp.data.diversificationScore !== null
              ? `Diversification: ${(resp.data.diversificationScore * 100).toFixed(0)}%`
              : 'Insufficient overlap'}
          </div>
        )}
      </div>

      <p className="text-xs text-slate-400 mb-6 font-mono max-w-2xl">
        Real Pearson correlation between your actual open positions&apos; daily returns - the same
        computation RiskEngine&apos;s own correlation_exposure gate relies on. A pair without enough
        overlapping real daily closes shows as AWAITING SIGNAL rather than a fabricated coefficient.
        Diversification score is 1 minus the mean absolute correlation across all computable pairs.
      </p>

      {loading ? (
        <div className="py-8 text-center text-slate-500 text-xs font-mono">Loading real portfolio correlation data...</div>
      ) : !resp?.available ? (
        <AwaitingSignal reason={resp?.reason ?? 'Need at least 2 open real positions to compute correlation.'} />
      ) : symbols.length === 0 ? (
        <AwaitingSignal reason="No computable symbol pairs yet." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <div className="min-w-max">
              <div className="flex mb-1">
                <div className="w-20 shrink-0" />
                {symbols.map((s) => (
                  <div key={`header-${s}`} className="w-20 shrink-0 text-center text-[9px] font-mono text-slate-400 uppercase tracking-wider font-bold" title={s}>
                    {s}
                  </div>
                ))}
              </div>
              {symbols.map((rowSymbol) => (
                <div key={`row-${rowSymbol}`} className="flex mb-1 items-center">
                  <div className="w-20 shrink-0 text-right pr-3 text-[9px] font-mono text-slate-400 uppercase tracking-wider font-bold" title={rowSymbol}>
                    {rowSymbol}
                  </div>
                  {symbols.map((colSymbol) => {
                    const { val, found } = matrixValue(rowSymbol, colSymbol);
                    return (
                      <div key={`cell-${rowSymbol}-${colSymbol}`} className="w-20 h-8 shrink-0 p-0.5">
                        {!found || val === null ? (
                          <div
                            className="w-full h-full rounded flex items-center justify-center border border-dashed border-slate-700/60 bg-slate-900/40"
                            title={`${rowSymbol} vs ${colSymbol}: not enough overlapping real daily closes yet.`}
                          >
                            <span className="text-[8px] font-mono text-slate-600">N/A</span>
                          </div>
                        ) : (
                          <div
                            className={`w-full h-full rounded flex items-center justify-center text-[10px] font-mono font-medium transition-colors border border-slate-900/50 ${getColorForCorrelation(val)}`}
                            title={`${rowSymbol} vs ${colSymbol}: ${val.toFixed(2)}`}
                          >
                            {val.toFixed(2)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {resp.data && resp.data.clusters.length > 0 && (
            <div className="mt-6 pt-4 border-t border-slate-800/60">
              <span className="text-[10px] uppercase font-mono text-slate-500 block mb-2">
                Real Correlation Clusters (|correlation| &ge; {resp.data.clusterThreshold})
              </span>
              <div className="flex flex-wrap gap-2">
                {resp.data.clusters.map((c, i) => (
                  <div key={i} className="bg-slate-800/60 border border-slate-700/50 rounded px-2 py-1 text-[10px] font-mono text-slate-300">
                    {c.symbols.join(' + ')} <span className="text-slate-500">({c.averageIntraClusterCorrelation.toFixed(2)} avg)</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6 pt-4 border-t border-slate-800/60 flex flex-wrap gap-4 items-center justify-center text-[9px] font-mono uppercase tracking-widest text-slate-500">
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500/90 inline-block" /> High Sync (+1.0)</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-800 inline-block" /> Neutral (0.0)</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-rose-500/90 inline-block" /> Inverse (-1.0)</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border border-dashed border-slate-700/60 inline-block" /> Awaiting Signal</div>
          </div>
        </>
      )}
    </div>
  );
};

export default PortfolioCorrelationPanel;
