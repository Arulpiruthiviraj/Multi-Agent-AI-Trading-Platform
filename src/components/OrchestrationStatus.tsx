/**
 * Live model-health + Argus-vs-broker capital readout. Values come from
 * GET /api/v2/orchestration/* — never fabricated. Animation is not this panel;
 * DigitalTwinVisualizer still lights nodes only from real WebSocket events.
 */
import React from 'react';

export default function OrchestrationStatus({ models, capital }: { models: any[] | null; capital: any | null }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
      <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
        <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-3">Model runtime</div>
        {!models && (
          <div className="text-[10px] text-slate-600 font-mono">
            Model registry has not loaded yet (GET /api/v2/orchestration/models). This is a missing snapshot, not a claim that every model is down.
          </div>
        )}
        {models && models.map((m) => (
          <div key={m.modelId} className="flex items-start justify-between gap-3 py-1.5 border-b border-slate-800/80 last:border-0">
            <div>
              <div className="text-[11px] font-bold text-white font-mono">{m.modelId}</div>
              <div className="text-[9px] text-slate-500 mt-0.5">{m.detail}</div>
              {m.health === 'FAILED' && m.action && <div className="text-[9px] text-amber-400 mt-0.5">Action: {m.action}</div>}
            </div>
            <span className={`text-[9px] font-bold tracking-widest ${m.health === 'READY' ? 'text-emerald-400' : m.health === 'DISABLED' ? 'text-slate-500' : 'text-rose-400'}`}>
              {m.health}
            </span>
          </div>
        ))}
        {models && (
          <p className="text-[9px] text-slate-600 mt-2">Chronos/Ollama/OpenAlice are optional evidence sources. FAILED does not by itself block RiskEngine.</p>
        )}
      </div>
      <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
        <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-3">Broker vs Argus allocation</div>
        {!capital?.ok && (
          <div className="text-[10px] text-slate-600 font-mono">
            {capital?.error
              ? `Capital snapshot failed: ${capital.error}`
              : 'Capital snapshot has not loaded yet (GET /api/v2/orchestration/capital). Broker vs Argus numbers are unknown until this succeeds — they are not assumed to be zero.'}
          </div>
        )}
        {capital?.ok && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[11px]">
            <span className="text-slate-500">Broker equity</span>
            <span className="text-white text-right">${Number(capital.broker.equity ?? 0).toFixed(2)}</span>
            <span className="text-slate-500">Cash</span>
            <span className="text-white text-right">${Number(capital.broker.cash ?? 0).toFixed(2)}</span>
            <span className="text-slate-500">Buying power</span>
            <span className="text-white text-right">${Number(capital.broker.buyingPower ?? 0).toFixed(2)}</span>
            <span className="text-slate-500">Invested</span>
            <span className="text-white text-right">${Number(capital.broker.investedCapital ?? 0).toFixed(2)}</span>
            <span className="text-slate-500">Unrealized P&L</span>
            <span className="text-white text-right">{capital.broker.unrealizedPnl == null ? '—' : `$${Number(capital.broker.unrealizedPnl).toFixed(2)}`}</span>
            <span className="text-indigo-300">Allocated to Argus</span>
            <span className="text-indigo-300 text-right">${Number(capital.argus.allocated).toFixed(2)}</span>
            <span className="text-amber-300">Currently used</span>
            <span className="text-amber-300 text-right">${Number(capital.argus.used).toFixed(2)}</span>
            <span className="text-emerald-300">Available allocation</span>
            <span className="text-emerald-300 text-right">${Number(capital.argus.remaining).toFixed(2)}</span>
            <span className="text-slate-500">Open positions / orders</span>
            <span className="text-white text-right">{capital.broker.openPositions} / {capital.broker.openOrders}</span>
          </div>
        )}
        <p className="text-[9px] text-slate-600 mt-3 leading-relaxed">
          Broker cash is not trading authority. Argus may only commit up to the allocated slice; this is enforced in RiskEngine, not in the UI.
        </p>
      </div>
    </div>
  );
}
