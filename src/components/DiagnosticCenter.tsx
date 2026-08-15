import React, { useEffect, useState } from 'react';
import { Activity, RefreshCw, HelpCircle } from 'lucide-react';
import ExplainCard from './ExplainCard';

export default function DiagnosticCenter() {
  const [snap, setSnap] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [whyId, setWhyId] = useState('');
  const [why, setWhy] = useState<any>(null);

  const load = () => {
    fetch('/api/v2/diagnostics')
      .then(r => r.json())
      .then(j => { if (j.ok) { setSnap(j); setError(null); } else setError(j.error || 'diagnostics request failed'); })
      .catch(e => setError(e.message));
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const retry = (component: string) => {
    fetch(`/api/v2/diagnostics/retry/${component}`, { method: 'POST' })
      .then(() => load())
      .catch(() => load());
  };

  const loadWhy = () => {
    if (!whyId.trim()) return;
    fetch(`/api/v2/diagnostics/why/${encodeURIComponent(whyId.trim())}`)
      .then(r => r.json())
      .then(setWhy)
      .catch(e => setWhy({ ok: false, error: e.message }));
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2 uppercase tracking-wide">
            <Activity size={18} className="text-amber-400" /> System health / diagnostics
          </h2>
          <p className="text-[11px] text-slate-500 mt-1 font-mono">
            Every card is built from live probes and persisted rows. Optional models do not silently look healthy. RiskEngine is never bypassed from this page.
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 text-amber-400 text-[10px] uppercase font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && (
        <ExplainCard d={{
          component: 'SYSTEM', status: 'UNAVAILABLE', severity: 'ERROR', title: 'Diagnostics snapshot failed',
          userMessage: error, cause: error, impact: 'This page cannot show live health until the API responds.',
          tradingImpact: 'Unknown — open server logs. This page failure does not itself place or cancel orders.',
          canContinueSafely: true, recommendedFix: 'Check that the Argus API is running on port 3000.',
          troubleshootingSteps: ['Confirm npm run dev', 'Retry'], code: 'SYS-API', timestamp: new Date().toISOString(),
        }} />
      )}

      {snap?.whyNotTrading && (
        <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4">
          <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 flex items-center gap-2">
            <HelpCircle size={12} /> Why is Argus not trading?
          </div>
          <div className="text-sm font-bold text-white mb-2">
            {snap.whyNotTrading.isTrading ? 'Autobot is enabled and no blocking diagnostic is active.' : 'Argus is currently not taking new entries (or Autobot is off).'}
          </div>
          {snap.whyNotTrading.primary && <ExplainCard d={snap.whyNotTrading.primary} />}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-3">
            {(snap.whyNotTrading.passing || []).map((p: any) => (
              <div key={p.component} className={`text-[10px] font-mono px-2 py-1.5 rounded border ${p.ok ? 'border-emerald-800 text-emerald-400' : 'border-rose-800 text-rose-400'}`}>
                {p.ok ? '✓' : '✗'} {p.component} — {p.note}
              </div>
            ))}
          </div>
        </div>
      )}

      {snap?.capital && (
        <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 font-mono text-[11px] grid grid-cols-2 gap-2">
          <div className="text-slate-500 col-span-2 uppercase tracking-widest text-[10px]">Capital — broker vs Argus</div>
          <span className="text-slate-500">Broker equity</span><span className="text-right text-white">${Number(snap.capital.broker.equity).toFixed(2)}</span>
          <span className="text-slate-500">Broker buying power</span><span className="text-right text-white">${Number(snap.capital.broker.buyingPower).toFixed(2)}</span>
          <span className="text-indigo-300">Argus allocated</span><span className="text-right text-indigo-300">${Number(snap.capital.argus.allocated).toFixed(2)}</span>
          <span className="text-amber-300">Used (positions + reserved)</span><span className="text-right text-amber-300">${Number(snap.capital.argus.used).toFixed(2)}</span>
          <span className="text-emerald-300">Argus remaining</span><span className="text-right text-emerald-300">${Number(snap.capital.argus.remaining).toFixed(2)}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {(snap?.diagnostics || []).map((d: any) => (
          <div key={d.id}>
            <ExplainCard d={d} compact />
            {d.retryable && (
              <button
                onClick={() => retry(d.component.toLowerCase())}
                className="mt-1 text-[9px] uppercase font-bold text-slate-500 hover:text-white"
              >
                Retry probe ({d.component})
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4">
        <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2">Why did Argus trade / not trade / sell?</div>
        <p className="text-[10px] text-slate-500 mb-2">Paste a real transaction id from Observability. The answer is assembled from persisted consensus, risk gates, and fills only.</p>
        <div className="flex gap-2">
          <input value={whyId} onChange={e => setWhyId(e.target.value)} placeholder="transaction id" className="flex-1 bg-[#0A0F16] border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono" />
          <button onClick={loadWhy} className="px-3 py-1 bg-indigo-600 text-white text-[10px] font-bold uppercase rounded">Explain</button>
        </div>
        {why && (
          <pre className="mt-3 text-[10px] text-emerald-400 bg-[#0A0F16] border border-slate-800 rounded p-3 overflow-auto max-h-80">
            {JSON.stringify(why, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
