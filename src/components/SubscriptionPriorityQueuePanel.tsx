/**
 * Phase 4D (Dynamic Subscription Priority Queue) - real capacity/utilization snapshot
 * (GET /api/v2/continuous-intelligence/capacity) plus real promotion/eviction decisions with
 * reasons (GET /api/v2/continuous-intelligence/subscription-decisions). Discovery only.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Radar, RefreshCw } from 'lucide-react';

interface CapacitySnapshot {
  activeCount: number;
  effectiveCap: number;
  utilizationPct: number;
  emptySlots: number;
  coreCount: number;
  dynamicCount: number;
}

interface SubscriptionDecision {
  ts: string;
  symbol: string;
  action: string;
  reason: string | null;
}

const ACTION_COLOR: Record<string, string> = {
  PROMOTED: 'text-emerald-400', EVICTED: 'text-rose-400',
  NOT_PROMOTED: 'text-slate-500', ALREADY_ACTIVE: 'text-slate-600',
};

export default function SubscriptionPriorityQueuePanel() {
  const [capacity, setCapacity] = useState<CapacitySnapshot | null>(null);
  const [decisions, setDecisions] = useState<SubscriptionDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAll = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/v2/continuous-intelligence/capacity', { signal: controller.signal })
      .then((r) => r.json()).then((d) => { if (d.ok) setCapacity(d); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
    fetch('/api/v2/continuous-intelligence/subscription-decisions?limit=20', { signal: controller.signal })
      .then((r) => r.json()).then((d) => { if (d.ok) setDecisions(d.decisions || []); })
      .catch(() => {});
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 20000);
    return () => { clearInterval(interval); abortRef.current?.abort(); };
  }, []);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <Radar size={14} className="text-orange-400" /> Subscription priority queue
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Real capacity + real promotion/eviction reasons — never a fabricated queue
          </p>
        </div>
        <button onClick={fetchAll} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-orange-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load subscription queue: {error}</p>}

      {capacity && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4 text-[11px] font-mono">
          <div className="bg-[#111822] border border-slate-800 rounded p-2">
            <div className="text-[9px] text-slate-500 uppercase">Utilization</div>
            <div className="text-slate-200">{capacity.activeCount}/{capacity.effectiveCap} ({(capacity.utilizationPct * 100).toFixed(0)}%)</div>
          </div>
          <div className="bg-[#111822] border border-slate-800 rounded p-2">
            <div className="text-[9px] text-slate-500 uppercase">Empty slots</div>
            <div className="text-slate-200">{capacity.emptySlots}</div>
          </div>
          <div className="bg-[#111822] border border-slate-800 rounded p-2">
            <div className="text-[9px] text-slate-500 uppercase">Core / Anchor</div>
            <div className="text-slate-200">{capacity.coreCount}</div>
          </div>
          <div className="bg-[#111822] border border-slate-800 rounded p-2">
            <div className="text-[9px] text-slate-500 uppercase">Dynamic</div>
            <div className="text-slate-200">{capacity.dynamicCount}</div>
          </div>
        </div>
      )}

      <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Recent promotion/eviction decisions</h4>
      {decisions.length === 0 ? (
        <p className="text-[11px] text-slate-600">No subscription-priority decisions recorded yet.</p>
      ) : (
        <div className="space-y-1">
          {decisions.map((d, i) => (
            <div key={`${d.ts}-${d.symbol}-${i}`} className="flex items-start gap-3 text-[11px] border-t border-slate-800 pt-1.5">
              <span className="text-slate-600 shrink-0">{new Date(d.ts).toLocaleTimeString()}</span>
              <span className="font-bold text-slate-200 shrink-0">{d.symbol}</span>
              <span className={`shrink-0 font-bold ${ACTION_COLOR[d.action] || 'text-slate-400'}`}>{d.action}</span>
              <span className="text-slate-500">{d.reason || '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
