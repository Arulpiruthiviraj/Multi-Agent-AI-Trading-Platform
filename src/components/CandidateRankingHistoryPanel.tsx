/**
 * Phase 4C (Composable Candidate Ranking) - real, persisted per-component ranking breakdown
 * (GET /api/v2/continuous-intelligence/ranking/latest). Distinct from Phase 3C's
 * CandidateRankingPanel (which shows only SnapshotScanner's live momentum/RVOL/range top-12) -
 * this shows the full, explainable component set every scanned symbol was actually scored on,
 * including which components were unavailable and why.
 */
import React, { useEffect, useRef, useState } from 'react';
import { LayoutList, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

interface RankedCandidate {
  symbol: string;
  rank: number;
  previousRank: number | null;
  rankDelta: number | null;
  finalScore: number;
  components: Record<string, number | null>;
  componentAvailability: Record<string, { available: boolean; reason?: string }>;
  promotionRecommendation: 'PROMOTE' | 'HOLD' | 'REJECT';
  promotionReason: string;
}

const COMPONENT_LABELS: Record<string, string> = {
  momentum: 'Momentum', relativeVolume: 'Rel. Volume', rangeExpansion: 'Range',
  gap: 'Gap', liquidity: 'Liquidity', newsCatalyst: 'News', agentConfidence: 'Agent Conf.',
};

export default function CandidateRankingHistoryPanel() {
  const [candidates, setCandidates] = useState<RankedCandidate[]>([]);
  const [cycleAt, setCycleAt] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchLatest = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/v2/continuous-intelligence/ranking/latest?limit=30', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { setError(d.error || 'unknown error'); return; }
        setError(null);
        setCandidates(d.candidates || []);
        setCycleAt(d.cycleAt);
      })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchLatest();
    const interval = setInterval(fetchLatest, 30000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, []);

  const recColor = (rec: string) =>
    rec === 'PROMOTE' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
      : rec === 'REJECT' ? 'text-rose-400 border-rose-500/30 bg-rose-500/10'
        : 'text-amber-400 border-amber-500/30 bg-amber-500/10';

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <LayoutList size={14} className="text-cyan-400" /> Composable ranking breakdown
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Every component individually observable — no fabricated data for unavailable fields
          </p>
        </div>
        <button onClick={fetchLatest} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load ranking cycle: {error}</p>}
      {cycleAt && <p className="text-[10px] text-slate-500 mb-3">Cycle: {new Date(cycleAt).toLocaleTimeString()}</p>}

      {candidates.length === 0 ? (
        <p className="text-[11px] text-slate-600">No ranking cycle recorded yet.</p>
      ) : (
        <div className="space-y-1.5">
          {candidates.map((c) => {
            const isOpen = expanded === c.symbol;
            return (
              <div key={c.symbol} className="border border-slate-800 rounded bg-[#111822]">
                <button className="w-full flex items-center justify-between px-3 py-2 text-left" onClick={() => setExpanded(isOpen ? null : c.symbol)}>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className="text-slate-600 w-6 text-right">#{c.rank}</span>
                    <span className="font-bold text-slate-200">{c.symbol}</span>
                    {c.rankDelta != null && c.rankDelta !== 0 && (
                      <span className={c.rankDelta > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {c.rankDelta > 0 ? '▲' : '▼'} {Math.abs(c.rankDelta)}
                      </span>
                    )}
                    <span className="text-slate-500">score {c.finalScore.toFixed(3)}</span>
                    <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${recColor(c.promotionRecommendation)}`}>
                      {c.promotionRecommendation}
                    </span>
                  </div>
                  {isOpen ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3">
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {Object.entries(COMPONENT_LABELS).map(([key, label]) => {
                        const avail = c.componentAvailability[key];
                        const value = c.components[key];
                        return (
                          <span
                            key={key}
                            title={avail?.available === false ? avail.reason : undefined}
                            className={`text-[9px] font-mono px-2 py-0.5 rounded border ${avail?.available === false ? 'border-slate-700 text-slate-600' : 'border-cyan-500/30 text-cyan-300'}`}
                          >
                            {label}: {avail?.available === false ? 'N/A' : value?.toFixed(2)}
                          </span>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-slate-500">{c.promotionReason}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
