/**
 * Phase 4F (Missed Opportunity Intelligence) - real, persisted classification of where a
 * PROMOTE-recommended candidate stalled in the funnel (GET /api/v2/continuous-intelligence/
 * missed-opportunities). Diagnostic only - has never emitted a trade idea or influenced sizing.
 */
import React, { useEffect, useRef, useState } from 'react';
import { SearchX, RefreshCw } from 'lucide-react';

interface MissedOpportunity {
  id: string;
  symbol: string;
  detectedAt: string;
  classification: string;
  classificationReason: string;
  priceAtDetection: number | null;
  evaluationStatus: 'PENDING' | 'EVALUATED';
  priceAtEvaluation: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
}

const CLASS_COLOR: Record<string, string> = {
  SUBSCRIPTION_MISS: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  AGENT_MISS: 'text-sky-400 border-sky-500/30 bg-sky-500/10',
  CONSENSUS_REJECTION: 'text-violet-400 border-violet-500/30 bg-violet-500/10',
  RISK_REJECTION: 'text-rose-400 border-rose-500/30 bg-rose-500/10',
  EXECUTION_MISS: 'text-orange-400 border-orange-500/30 bg-orange-500/10',
};

export default function MissedOpportunitiesPanel() {
  const [rows, setRows] = useState<MissedOpportunity[]>([]);
  const [byClassification, setByClassification] = useState<Record<string, number>>({});
  const [sinceMs, setSinceMs] = useState(24 * 60 * 60 * 1000);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch(`/api/v2/continuous-intelligence/missed-opportunities?sinceMs=${sinceMs}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) { setRows(d.rows || []); setByClassification(d.byClassification || {}); setError(null); }
        else setError(d.error || 'unknown error');
      })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => { clearInterval(interval); abortRef.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceMs]);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <SearchX size={14} className="text-orange-400" /> Missed opportunity intelligence
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Where a PROMOTE candidate stalled — diagnostic only, never re-fires a trade idea
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sinceMs} onChange={(e) => setSinceMs(Number(e.target.value))}
            className="bg-[#111822] border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-300"
          >
            <option value={3600000}>Last hour</option>
            <option value={14400000}>Last 4 hours</option>
            <option value={86400000}>Last 24 hours</option>
            <option value={604800000}>Last 7 days</option>
          </select>
          <button onClick={fetchData} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-orange-400 text-[10px] uppercase tracking-widest font-bold rounded">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load missed opportunities: {error}</p>}

      {Object.keys(byClassification).length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {Object.entries(byClassification).map(([cls, count]) => (
            <span key={cls} className={`text-[9px] font-bold uppercase px-2 py-1 rounded border ${CLASS_COLOR[cls] || 'text-slate-400 border-slate-600/30 bg-slate-600/10'}`}>
              {cls.replace(/_/g, ' ')}: {count}
            </span>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-[11px] text-slate-600">No missed opportunities detected in this window — either nothing ranked PROMOTE, or every PROMOTE candidate made it through the funnel.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-500 uppercase text-[9px] tracking-widest border-b border-slate-800">
                <th className="text-left py-1.5 pr-3">Symbol</th>
                <th className="text-left py-1.5 pr-3">Classification</th>
                <th className="text-left py-1.5 pr-3">Detected</th>
                <th className="text-left py-1.5 pr-3">Price</th>
                <th className="text-left py-1.5 pr-3">MFE / MAE</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-900" title={r.classificationReason}>
                  <td className="py-1.5 pr-3 font-bold text-slate-200">{r.symbol}</td>
                  <td className="py-1.5 pr-3">
                    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${CLASS_COLOR[r.classification] || 'text-slate-400 border-slate-600/30 bg-slate-600/10'}`}>
                      {r.classification.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-slate-500">{new Date(r.detectedAt).toLocaleTimeString()}</td>
                  <td className="py-1.5 pr-3 text-slate-400">{r.priceAtDetection?.toFixed(2) ?? 'n/a'}</td>
                  <td className="py-1.5 pr-3 text-slate-500">
                    {r.evaluationStatus === 'EVALUATED'
                      ? <span><span className="text-emerald-400">+{r.maxFavorableExcursionPct?.toFixed(2)}%</span> / <span className="text-rose-400">{r.maxAdverseExcursionPct?.toFixed(2)}%</span></span>
                      : <span className="text-slate-700">pending (retrospective)</span>}
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
