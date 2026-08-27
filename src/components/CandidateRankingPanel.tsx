/**
 * Phase 3C - Candidate Ranking. Real per-symbol discovery scores from SnapshotScanner.ts
 * (GET /api/v2/continuous-intelligence/status's lastScan.top), previously computed and cached
 * but only ever forwarded as bare symbol names. This is a DISCOVERY SCORE, not a trade signal and
 * not risk approval - SnapshotScanner.ts never imports OMS/RiskEngine/BrokerManager and never
 * emits TRADE_IDEA_GENERATED.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ListOrdered, RefreshCw } from 'lucide-react';

interface RankedCandidate {
  symbol: string;
  momentumScore: number;
  intradayPctChange: number;
  relativeVolume: number;
}

export default function CandidateRankingPanel() {
  const [candidates, setCandidates] = useState<RankedCandidate[]>([]);
  const [scannedCount, setScannedCount] = useState<number | null>(null);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStatus = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/v2/continuous-intelligence/status', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { setError(d.error || 'status endpoint returned ok:false'); return; }
        setError(null);
        setCandidates(Array.isArray(d.lastScan?.top) ? d.lastScan.top : []);
        setScannedCount(typeof d.lastScan?.scannedCount === 'number' ? d.lastScan.scannedCount : null);
        setTimestamp(d.lastScan?.timestamp ?? null);
      })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
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
            <ListOrdered size={14} className="text-amber-400" /> Candidate ranking
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Discovery score only — not a trade signal, not risk-approved, not order eligibility
          </p>
        </div>
        <button onClick={fetchStatus} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load candidate ranking: {error}</p>}

      <div className="flex gap-4 mb-3 text-[10px] text-slate-500 uppercase tracking-widest">
        {scannedCount != null && <span>Scanned: {scannedCount}</span>}
        {timestamp && <span>Last scan: {new Date(timestamp).toLocaleTimeString()}</span>}
      </div>

      {candidates.length === 0 ? (
        <p className="text-[11px] text-slate-600">
          No ranked candidates yet — the snapshot scan cycle has not produced a result in this session, or is outside RTH.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-500 uppercase tracking-widest text-left">
                <th className="pb-2 pr-4">#</th>
                <th className="pb-2 pr-4">Symbol</th>
                <th className="pb-2 pr-4">Score</th>
                <th className="pb-2 pr-4">Intraday %</th>
                <th className="pb-2 pr-4">Rel. volume</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c, i) => (
                <tr key={c.symbol} className="border-t border-slate-800 text-slate-300">
                  <td className="py-1.5 pr-4 text-slate-600">{i + 1}</td>
                  <td className="py-1.5 pr-4 font-bold">{c.symbol}</td>
                  <td className="py-1.5 pr-4">{c.momentumScore.toFixed(2)}</td>
                  <td className={`py-1.5 pr-4 ${c.intradayPctChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {c.intradayPctChange >= 0 ? '+' : ''}{c.intradayPctChange.toFixed(2)}%
                  </td>
                  <td className="py-1.5 pr-4">{c.relativeVolume.toFixed(2)}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
