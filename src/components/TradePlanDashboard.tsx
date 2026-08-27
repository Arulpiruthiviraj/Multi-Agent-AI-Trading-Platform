/**
 * Phase 4E (Pre-Market TradePlan) - real, persisted pre-market plans + revalidation history
 * (GET /api/v2/continuous-intelligence/trade-plans/:planDate). A TradePlan is a hypothesis, never
 * an order - building/persisting one has no effect on the live trading pipeline.
 */
import React, { useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

interface TradePlan {
  id: string;
  symbol: string;
  setupType: 'PRIMARY' | 'BACKUP' | 'WATCHLIST';
  direction: 'BUY' | 'SELL';
  thesis: string;
  catalysts: string[];
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  invalidationLevel: number | null;
  targetConcept: string;
  confidence: number;
  evidenceQuality: number;
  rankAtCreation: number;
  status: string;
  createdAt: string;
  validUntil: string;
}

const SETUP_COLOR: Record<string, string> = {
  PRIMARY: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  BACKUP: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  WATCHLIST: 'text-slate-400 border-slate-600/30 bg-slate-600/10',
};
const STATUS_COLOR: Record<string, string> = {
  READY: 'text-sky-400', VALID: 'text-emerald-400', REVALIDATING: 'text-amber-400',
  INVALIDATED: 'text-rose-400', EXPIRED: 'text-slate-600', EXECUTED: 'text-violet-400', CLOSED: 'text-slate-600',
};

export default function TradePlanDashboard() {
  const [plans, setPlans] = useState<TradePlan[]>([]);
  const [planDate, setPlanDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchPlans = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch(`/api/v2/continuous-intelligence/trade-plans/${planDate}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) { setPlans(d.plans || []); setError(null); } else setError(d.error || 'unknown error'); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchPlans();
    const interval = setInterval(fetchPlans, 30000);
    return () => { clearInterval(interval); abortRef.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planDate]);

  const bySetup = (type: string) => plans.filter((p) => p.setupType === type);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <FileText size={14} className="text-teal-400" /> Pre-market trade plan
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            A hypothesis, never an order — revalidated against live data before any decision
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date" value={planDate} onChange={(e) => setPlanDate(e.target.value)}
            className="bg-[#111822] border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-300"
          />
          <button onClick={fetchPlans} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-teal-400 text-[10px] uppercase tracking-widest font-bold rounded">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load trade plans: {error}</p>}

      {plans.length === 0 ? (
        <p className="text-[11px] text-slate-600">No trade plans recorded for this date yet — built once per pre-market cycle when the ranking pipeline runs.</p>
      ) : (
        <div className="space-y-4">
          {(['PRIMARY', 'BACKUP', 'WATCHLIST'] as const).map((setupType) => {
            const rows = bySetup(setupType);
            if (rows.length === 0) return null;
            return (
              <div key={setupType}>
                <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">{setupType} ({rows.length})</h4>
                <div className="space-y-1">
                  {rows.map((p) => {
                    const isOpen = expanded === p.id;
                    return (
                      <div key={p.id} className="border border-slate-800 rounded bg-[#111822]">
                        <button className="w-full flex items-center justify-between px-3 py-2 text-left" onClick={() => setExpanded(isOpen ? null : p.id)}>
                          <div className="flex items-center gap-3 text-[11px]">
                            <span className="font-bold text-slate-200">{p.symbol}</span>
                            <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${SETUP_COLOR[p.setupType]}`}>{p.direction}</span>
                            <span className={`text-[10px] font-bold uppercase ${STATUS_COLOR[p.status] || 'text-slate-400'}`}>{p.status}</span>
                            <span className="text-slate-500">conf {p.confidence.toFixed(2)}</span>
                          </div>
                          {isOpen ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
                        </button>
                        {isOpen && (
                          <div className="px-3 pb-3 text-[11px] space-y-1.5">
                            <p className="text-slate-400">{p.thesis}</p>
                            <div className="flex flex-wrap gap-3 text-slate-500">
                              <span>Entry: {p.entryZoneLow?.toFixed(2)} - {p.entryZoneHigh?.toFixed(2)}</span>
                              <span>Invalidation: {p.invalidationLevel?.toFixed(2)}</span>
                              <span>Evidence quality: {(p.evidenceQuality * 100).toFixed(0)}%</span>
                              <span>Rank at creation: #{p.rankAtCreation}</span>
                            </div>
                            {p.catalysts.length > 0 && <p className="text-cyan-400">{p.catalysts.join(', ')}</p>}
                            <p className="text-slate-600">Valid until {new Date(p.validUntil).toLocaleString()}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
