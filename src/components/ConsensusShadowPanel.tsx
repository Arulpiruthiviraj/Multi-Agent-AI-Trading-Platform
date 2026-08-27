/**
 * Phase 4B (Evidence-Aware Consensus, SHADOW MODE ONLY) - real-only legacy-vs-shadow consensus
 * divergence (GET /api/v2/consensus/shadow-comparison). The shadow model NEVER places or approves
 * a real trade - this is a validation surface only, per Phase 4 Part 2's requirement that the new
 * model not become active until runtime evidence supports it.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Scale, RefreshCw } from 'lucide-react';

interface ShadowComparison {
  ts: string;
  symbol: string;
  traceId: string;
  legacyDecision: string;
  legacyApproved: boolean;
  legacyConfidence: number;
  shadowDecision: string;
  shadowApproved: boolean;
  shadowConfidence: number;
  bullishEvidence: number;
  bearishEvidence: number;
  uncertainty: number;
  excludedAgents: Array<{ agent: string; reason: string }>;
  reasonCode: string;
  agree: boolean;
}

export default function ConsensusShadowPanel() {
  const [comparisons, setComparisons] = useState<ShadowComparison[]>([]);
  const [stats, setStats] = useState<{ agreeCount: number; disagreeCount: number; agreementRate: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchComparisons = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/v2/consensus/shadow-comparison?limit=30', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { setError(d.error || 'unknown error'); return; }
        setError(null);
        setComparisons(d.comparisons || []);
        setStats({ agreeCount: d.agreeCount, disagreeCount: d.disagreeCount, agreementRate: d.agreementRate });
      })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchComparisons();
    const interval = setInterval(fetchComparisons, 20000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, []);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <Scale size={14} className="text-violet-400" /> Consensus shadow validation
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Evidence-aware model, SHADOW ONLY — never places or approves a real trade
          </p>
        </div>
        <button onClick={fetchComparisons} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-violet-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load shadow comparisons: {error}</p>}

      {stats && stats.agreementRate != null && (
        <div className="flex gap-4 mb-4 text-[11px] font-mono">
          <span className="text-emerald-400">Agree: {stats.agreeCount}</span>
          <span className="text-amber-400">Disagree: {stats.disagreeCount}</span>
          <span className="text-slate-500">Agreement rate: {(stats.agreementRate * 100).toFixed(1)}%</span>
        </div>
      )}

      {comparisons.length === 0 ? (
        <p className="text-[11px] text-slate-600">No shadow comparisons recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-500 uppercase tracking-widest text-left">
                <th className="pb-2 pr-4">Time</th>
                <th className="pb-2 pr-4">Symbol</th>
                <th className="pb-2 pr-4">Legacy</th>
                <th className="pb-2 pr-4">Shadow</th>
                <th className="pb-2 pr-4">Bull/Bear/Uncert.</th>
                <th className="pb-2 pr-4">Excluded</th>
                <th className="pb-2">Match</th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((c, i) => (
                <tr key={`${c.traceId}-${i}`} className="border-t border-slate-800 text-slate-300">
                  <td className="py-1.5 pr-4 text-slate-500">{new Date(c.ts).toLocaleTimeString()}</td>
                  <td className="py-1.5 pr-4 font-bold">{c.symbol}</td>
                  <td className="py-1.5 pr-4">{c.legacyDecision} ({(c.legacyConfidence * 100).toFixed(0)}%)</td>
                  <td className="py-1.5 pr-4">{c.shadowDecision} ({(c.shadowConfidence * 100).toFixed(0)}%)</td>
                  <td className="py-1.5 pr-4 text-slate-500">
                    {(c.bullishEvidence * 100).toFixed(0)}/{(c.bearishEvidence * 100).toFixed(0)}/{(c.uncertainty * 100).toFixed(0)}
                  </td>
                  <td className="py-1.5 pr-4 text-slate-600">{c.excludedAgents.map((a) => a.agent).join(', ') || '—'}</td>
                  <td className="py-1.5">
                    <span className={c.agree ? 'text-emerald-400' : 'text-amber-400'}>{c.agree ? 'Agree' : 'Diverge'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
