/**
 * Connection status from GET /api/v2/diagnostics — no fabricated latency or uptime.
 */
import React, { useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import ExplainCard from './ExplainCard';

export default function ConnectionStatusDashboard() {
  const [diagnostics, setDiagnostics] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = () => {
    fetch('/api/v2/diagnostics')
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setError(d.error || 'Diagnostics API returned ok:false'); return; }
        setError(null);
        const wanted = new Set(['BROKER', 'MARKET_DATA', 'DATABASE', 'OLLAMA', 'CHRONOS', 'OPENALICE', 'NEWS']);
        setDiagnostics((d.diagnostics || []).filter((x: any) => wanted.has(x.component)));
      })
      .catch(e => setError(e.message));
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-[#111822] border border-slate-850 p-5 rounded-lg border-l-4 border-l-sky-500 font-mono mb-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <Activity size={14} className="text-sky-500" /> Connection diagnostics
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Live probes only — latency/uptime percentages are not invented
          </p>
        </div>
        <button onClick={fetchStatus} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-sky-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load diagnostics: {error}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {diagnostics.map(d => (
          <div key={d.id}>
            <ExplainCard d={d} compact />
          </div>
        ))}
      </div>
    </div>
  );
}
