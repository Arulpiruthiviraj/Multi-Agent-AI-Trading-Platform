/**
 * Phase 3D - Confluence Center. Read-only view of ConfluenceCoordinator.ts's real trigger
 * history (GET /api/v2/confluence/recent, backed by observability_events). Never a vote or a
 * consensus decision on its own - it only shows which agents were asked to evaluate a symbol
 * sooner than their own timer would have, and why others were skipped.
 */
import React, { useEffect, useRef, useState } from 'react';
import { GitMerge, RefreshCw } from 'lucide-react';

interface ConfluenceTrigger {
  ts: string;
  symbol: string;
  traceId: string | null;
  triggeredAgents: string[];
  skippedAgents: string[];
}

export default function ConfluenceCenter() {
  const [triggers, setTriggers] = useState<ConfluenceTrigger[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchTriggers = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/v2/confluence/recent?limit=30', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setTriggers(d.triggers || []); else setError(d.error || 'unknown error'); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchTriggers();
    const interval = setInterval(fetchTriggers, 20000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, []);

  return (
    <div className="bg-[#111822] border border-slate-850 p-5 rounded-lg border-l-4 border-l-teal-500 font-mono mb-8">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <GitMerge size={14} className="text-teal-400" /> Confluence coordinator
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            On-demand co-evaluation only — never changes ChiefTrader weights or the consensus threshold
          </p>
        </div>
        <button onClick={fetchTriggers} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-teal-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load confluence history: {error}</p>}

      {triggers.length === 0 ? (
        <p className="text-[11px] text-slate-600">
          No confluence trigger recorded yet — either the coordinator is disabled, or no TechnicalAgent signal has cleared the confidence threshold.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-500 uppercase tracking-widest text-left">
                <th className="pb-2 pr-4">Time</th>
                <th className="pb-2 pr-4">Symbol</th>
                <th className="pb-2 pr-4">Triggered</th>
                <th className="pb-2 pr-4">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((t, i) => (
                <tr key={`${t.ts}-${t.symbol}-${i}`} className="border-t border-slate-800 text-slate-300">
                  <td className="py-1.5 pr-4 text-slate-500">{new Date(t.ts).toLocaleTimeString()}</td>
                  <td className="py-1.5 pr-4 font-bold">{t.symbol}</td>
                  <td className="py-1.5 pr-4 text-emerald-400">{t.triggeredAgents.join(', ') || '—'}</td>
                  <td className="py-1.5 pr-4 text-slate-600">{t.skippedAgents.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
