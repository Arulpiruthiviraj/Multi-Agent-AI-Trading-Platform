import React, { useState } from 'react';
import { Layers, ListOrdered } from 'lucide-react';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { fmtUsd } from './mobileUtils';

export function MobilePositionsOrders() {
  const portfolio = useMobileMissionSelector((s) => s.portfolio);
  const capital = useMobileMissionSelector((s) => s.capital);
  const [tab, setTab] = useState<'positions' | 'orders'>('positions');

  const positions = portfolio?.positions ?? [];
  const openOrders = capital?.openOrders;

  return (
    <section className="rounded-xl border border-slate-800 bg-[#111822] p-4">
      <div className="flex rounded-lg border border-slate-800 overflow-hidden mb-3">
        <button
          type="button"
          onClick={() => setTab('positions')}
          className={`flex-1 min-h-[44px] text-[10px] font-mono uppercase tracking-wider flex items-center justify-center gap-1.5 ${
            tab === 'positions' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-500'
          }`}
        >
          <Layers size={14} /> Positions ({positions.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('orders')}
          className={`flex-1 min-h-[44px] text-[10px] font-mono uppercase tracking-wider flex items-center justify-center gap-1.5 ${
            tab === 'orders' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-500'
          }`}
        >
          <ListOrdered size={14} /> Orders ({openOrders ?? '--'})
        </button>
      </div>

      {tab === 'positions' && (
        <div className="space-y-2 max-h-56 overflow-y-auto">
          {positions.length === 0 ? (
            <p className="text-[10px] font-mono text-slate-500 py-4 text-center">No open positions from broker snapshot.</p>
          ) : (
            positions.map((p) => (
              <div key={p.symbol} className="flex items-center justify-between py-2 border-b border-slate-800/80 last:border-0">
                <div>
                  <p className="text-sm font-bold font-mono text-white">{p.symbol}</p>
                  <p className="text-[10px] font-mono text-slate-500">{p.quantity} sh</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-mono text-slate-200">{fmtUsd(p.marketValue ?? (p.currentPrice != null ? p.currentPrice * p.quantity : null))}</p>
                  {p.unrealizedPl != null && (
                    <p className={`text-[10px] font-mono ${p.unrealizedPl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {fmtUsd(p.unrealizedPl)}
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'orders' && (
        <div className="py-4 text-center space-y-2">
          <p className="text-[10px] font-mono text-slate-400">
            Open orders count from <code className="text-indigo-300">GET /api/v2/orchestration/capital</code>
          </p>
          <p className="text-2xl font-mono font-bold text-white">{openOrders ?? '--'}</p>
          <p className="text-[9px] font-mono text-slate-600">
            Per-order detail is not exposed on a dedicated mobile list endpoint — tap a transaction in Closed Trades for OMS trace.
          </p>
        </div>
      )}
    </section>
  );
}
