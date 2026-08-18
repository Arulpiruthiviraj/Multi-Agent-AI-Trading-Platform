/**
 * ==========================================================
 * Module: StrategySynergyMatrix
 *
 * Purpose:
 * Phase 3B of FINAL_ANALYSIS.md's 4-phase remediation plan. This used to render a fabricated 6x6
 * correlation matrix between invented agent names ("Macro", "News", "Tech", "Sentiment", "Event",
 * "Geopol") - none of which correspond to any real agent in this codebase - via a deterministic
 * index-seeded formula with hardcoded special-case values. Now fetches
 * GET /api/v2/strategy/agent-synergy, which computes a real Pearson correlation
 * (src/server/services/AgentSynergy.ts) over real agent_predictions rows for the five agents this
 * codebase actually runs: TechnicalAgent, NewsAgent, FundamentalAgent, MacroAgent,
 * KronosForecastAgent. A pair with too few overlapping real predictions renders as AWAITING
 * SIGNAL, never a fabricated coefficient.
 * ==========================================================
 */

import React, { useEffect, useRef, useState } from 'react';
import { Network } from 'lucide-react';
import AwaitingSignal from './shared/AwaitingSignal';

const SHORT_LABEL: Record<string, string> = {
  TechnicalAgent: 'TECH',
  NewsAgent: 'NEWS',
  FundamentalAgent: 'FUND',
  MacroAgent: 'MACRO',
  KronosForecastAgent: 'KRONOS',
};

interface SynergyResponse {
  ok: boolean;
  agents: string[];
  matrix: (number | null)[][];
  sampleCounts: number[][];
  windowDays: number;
  sampleSize: number;
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

const StrategySynergyMatrix = () => {
  const [data, setData] = useState<SynergyResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Real perf fix (2026-08-18): 60s poll with no cancellation.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      fetch('/api/v2/strategy/agent-synergy', { signal: controller.signal })
        .then(r => r.json())
        .then(json => {
          if (!cancelled && json.ok) {
            setData(json);
            setLoading(false);
          }
        })
        .catch((e) => { if (!cancelled && e?.name !== 'AbortError') setLoading(false); });
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); abortRef.current?.abort(); };
  }, []);

  const agents = data?.agents ?? [];

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 lg:p-6 shadow-md relative overflow-hidden group hover:border-indigo-500/30 transition-all duration-300 w-full">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
          <Network size={16} className="text-indigo-400" />
          Strategy Synergy Matrix
        </h3>
        <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest bg-slate-800/50 px-2 py-1 rounded border border-slate-700/50">
          {data ? `${data.windowDays}D · ${data.sampleSize} REAL PREDICTIONS` : 'Cross-Agent Correlation'}
        </div>
      </div>

      <p className="text-xs text-slate-400 mb-6 font-mono max-w-2xl">
        Real Pearson correlation between the five agents Argus actually runs, computed over their
        real logged predictions on identical assets. High positive correlation (&gt;0.7) suggests
        redundant signaling, negative correlation implies structural hedging. A pair without enough
        overlapping real predictions shows as AWAITING SIGNAL rather than a fabricated number.
      </p>

      {loading ? (
        <div className="py-8 text-center text-slate-500 text-xs font-mono">Loading real agent-synergy data...</div>
      ) : agents.length === 0 ? (
        <AwaitingSignal reason="No agent predictions recorded yet." />
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-max">
            <div className="flex mb-1">
              <div className="w-28 shrink-0"></div>
              {agents.map((agent, i) => (
                <div key={`header-${i}`} className="w-20 shrink-0 text-center text-[9px] font-mono text-slate-400 uppercase tracking-wider font-bold" title={agent}>
                  {SHORT_LABEL[agent] || agent}
                </div>
              ))}
            </div>

            {agents.map((rowAgent, i) => (
              <div key={`row-${i}`} className="flex mb-1 items-center">
                <div className="w-28 shrink-0 text-right pr-4 text-[9px] font-mono text-slate-400 uppercase tracking-wider font-bold" title={rowAgent}>
                  {SHORT_LABEL[rowAgent] || rowAgent}
                </div>
                {agents.map((colAgent, j) => {
                  const val = data!.matrix[i][j];
                  const n = data!.sampleCounts[i][j];
                  return (
                    <div key={`cell-${i}-${j}`} className="w-20 h-8 shrink-0 p-0.5">
                      {val === null ? (
                        <div
                          className="w-full h-full rounded flex items-center justify-center border border-dashed border-slate-700/60 bg-slate-900/40"
                          title={`${rowAgent} vs ${colAgent}: not enough overlapping real predictions yet (${n} day(s) of shared data).`}
                        >
                          <span className="text-[8px] font-mono text-slate-600">N/A</span>
                        </div>
                      ) : (
                        <div
                          className={`w-full h-full rounded flex items-center justify-center text-[10px] font-mono font-medium transition-colors border border-slate-900/50 ${getColorForCorrelation(val)}`}
                          title={`${rowAgent} vs ${colAgent}: ${val.toFixed(2)} (${n} overlapping day(s) of real data)`}
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
      )}

      <div className="mt-6 pt-4 border-t border-slate-800/60 flex flex-wrap gap-4 items-center justify-center text-[9px] font-mono uppercase tracking-widest text-slate-500">
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500/90 inline-block"></span> High Sync (+1.0)</div>
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-slate-800 inline-block"></span> Neutral (0.0)</div>
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-rose-500/90 inline-block"></span> Inverse (-1.0)</div>
        <div className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border border-dashed border-slate-700/60 inline-block"></span> Awaiting Signal</div>
      </div>
    </div>
  );
};

export default StrategySynergyMatrix;
