/**
 * Phase 3E - Java Quant Core + parity dashboard. Read-only view of QuantCoreBridge.ts's real
 * connectivity state and the real QUANT_CORE_PARITY_DIVERGENCE rows persisted to
 * observability_events (GET /api/v2/quant-core/health, /parity). Never implies execution
 * authority - CLAUDE.md section 13: "Never expose the Java core as an execution authority."
 */
import React, { useEffect, useRef, useState } from 'react';
import { Cpu, RefreshCw } from 'lucide-react';

interface QuantCoreHealth {
  ok: boolean;
  enabled: boolean;
  liveIdeasEnabled: boolean;
  connected: boolean;
  checkedAt: string;
  detail?: string;
}

interface ParityFieldDivergence {
  field: string;
  tsValue: number;
  javaValue: number;
  diffPct: number;
}

interface ParityRow {
  ts: string;
  symbol: string;
  divergences: ParityFieldDivergence[];
}

export default function JavaQuantCoreDashboard() {
  const [health, setHealth] = useState<QuantCoreHealth | null>(null);
  const [rows, setRows] = useState<ParityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAll = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetch('/api/v2/quant-core/health', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setHealth(d); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });

    fetch('/api/v2/quant-core/parity?limit=25', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setRows(d.divergences || []); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 20000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, []);

  const modeLabel = !health?.enabled
    ? 'DISABLED'
    : health.liveIdeasEnabled
      ? 'LIVE IDEAS ENABLED'
      : 'ADVISORY / SHADOW';
  const modeColor = !health?.enabled
    ? 'text-slate-500 bg-slate-500/10 border-slate-500/30'
    : health.liveIdeasEnabled
      ? 'text-rose-400 bg-rose-500/10 border-rose-500/30'
      : 'text-sky-400 bg-sky-500/10 border-sky-500/30';

  return (
    <div className="bg-[#111822] border border-slate-850 p-5 rounded-lg border-l-4 border-l-indigo-500 font-mono mb-8">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <Cpu size={14} className="text-indigo-400" /> Java quant core
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Advisory bridge only — never places orders, never bypasses ChiefTrader/RiskEngine/OMS
          </p>
        </div>
        <button onClick={fetchAll} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-indigo-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load quant core status: {error}</p>}

      <div className="flex flex-wrap gap-3 mb-5">
        <div className={`border rounded-lg px-3 py-2 text-[11px] font-bold uppercase tracking-widest ${modeColor}`}>
          {modeLabel}
        </div>
        <div className={`border rounded-lg px-3 py-2 text-[11px] font-bold uppercase tracking-widest ${health?.connected ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' : 'text-slate-500 bg-slate-500/10 border-slate-500/30'}`}>
          {health?.connected ? 'Connected' : 'Not connected'}
        </div>
        {health?.checkedAt && (
          <div className="text-[10px] text-slate-500 self-center uppercase tracking-widest">
            Last checked {new Date(health.checkedAt).toLocaleTimeString()}
          </div>
        )}
      </div>
      {health?.detail && !health.connected && (
        <p className="text-[11px] text-slate-500 mb-4">{health.detail}</p>
      )}

      <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
        Recent TS/Java indicator parity divergences ({rows.length})
      </h4>
      {rows.length === 0 ? (
        <p className="text-[11px] text-slate-600">
          No divergence recorded yet — either the bridge is disabled, or TS and Java have agreed on every comparison so far.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-500 uppercase tracking-widest text-left">
                <th className="pb-2 pr-4">Time</th>
                <th className="pb-2 pr-4">Symbol</th>
                <th className="pb-2 pr-4">Field</th>
                <th className="pb-2 pr-4">TS value</th>
                <th className="pb-2 pr-4">Java value</th>
                <th className="pb-2 pr-4">Diff</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) =>
                row.divergences.map((d, i) => (
                  <tr key={`${row.ts}-${row.symbol}-${d.field}-${i}`} className="border-t border-slate-800 text-slate-300">
                    <td className="py-1.5 pr-4 text-slate-500">{new Date(row.ts).toLocaleTimeString()}</td>
                    <td className="py-1.5 pr-4 font-bold">{row.symbol}</td>
                    <td className="py-1.5 pr-4">{d.field}</td>
                    <td className="py-1.5 pr-4">{d.tsValue.toFixed(4)}</td>
                    <td className="py-1.5 pr-4">{d.javaValue.toFixed(4)}</td>
                    <td className="py-1.5 pr-4 text-amber-400">{(d.diffPct * 100).toFixed(3)}%</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
