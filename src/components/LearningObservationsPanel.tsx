/**
 * Phase 4G (Learning expansion) - trust-level breakdown of learning observations
 * (GET /api/v2/continuous-intelligence/learning/observations). EXECUTED (real, filled, risk-checked
 * trades) is shown distinctly from OBSERVATIONAL (rejected candidates / missed opportunities) —
 * the whole point of this panel is to never let the two look the same weight of evidence.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GraduationCap, RefreshCw } from 'lucide-react';

interface LearningObservation {
  id: string;
  symbol: string;
  observationType: 'CLOSED_TRADE' | 'REJECTED_CANDIDATE' | 'MISSED_OPPORTUNITY';
  trustLevel: 'EXECUTED' | 'OBSERVATIONAL';
  createdAt: string;
}

interface Breakdown {
  executed: number;
  observational: number;
  byType: Record<string, number>;
}

export default function LearningObservationsPanel() {
  const [rows, setRows] = useState<LearningObservation[]>([]);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/v2/continuous-intelligence/learning/observations', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) { setRows(d.rows || []); setBreakdown(d.breakdown || null); setError(null); }
        else setError(d.error || 'unknown error');
      })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => { clearInterval(interval); abortRef.current?.abort(); };
  }, []);

  const total = (breakdown?.executed ?? 0) + (breakdown?.observational ?? 0);
  const executedPct = total > 0 ? ((breakdown!.executed / total) * 100) : 0;

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <GraduationCap size={14} className="text-emerald-400" /> Learning observations
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Executed evidence vs observational evidence — never weighted the same
          </p>
        </div>
        <button onClick={fetchData} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load learning observations: {error}</p>}

      {breakdown && total > 0 && (
        <div className="mb-4">
          <div className="flex h-2 rounded overflow-hidden bg-slate-800">
            <div className="bg-violet-500" style={{ width: `${executedPct}%` }} />
            <div className="bg-slate-600" style={{ width: `${100 - executedPct}%` }} />
          </div>
          <div className="flex justify-between mt-1.5 text-[10px] text-slate-500">
            <span><span className="text-violet-400 font-bold">{breakdown.executed}</span> EXECUTED (real fills)</span>
            <span><span className="text-slate-300 font-bold">{breakdown.observational}</span> OBSERVATIONAL (rejected / missed)</span>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            {Object.entries(breakdown.byType).map(([type, count]) => (
              <span key={type} className="text-[9px] font-bold uppercase px-2 py-1 rounded border text-slate-400 border-slate-600/30 bg-slate-600/10">
                {type.replace(/_/g, ' ')}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-[11px] text-slate-600">No learning observations recorded yet.</p>
      ) : (
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-500 uppercase text-[9px] tracking-widest border-b border-slate-800">
                <th className="text-left py-1.5 pr-3">Symbol</th>
                <th className="text-left py-1.5 pr-3">Type</th>
                <th className="text-left py-1.5 pr-3">Trust</th>
                <th className="text-left py-1.5 pr-3">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 30).map((r) => (
                <tr key={r.id} className="border-b border-slate-900">
                  <td className="py-1.5 pr-3 font-bold text-slate-200">{r.symbol}</td>
                  <td className="py-1.5 pr-3 text-slate-400">{r.observationType.replace(/_/g, ' ')}</td>
                  <td className="py-1.5 pr-3">
                    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${r.trustLevel === 'EXECUTED' ? 'text-violet-400 border-violet-500/30 bg-violet-500/10' : 'text-slate-400 border-slate-600/30 bg-slate-600/10'}`}>
                      {r.trustLevel}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-slate-500">{new Date(r.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
