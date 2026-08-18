import React, { useState } from 'react';
import { History } from 'lucide-react';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { fmtUsd, truncateText } from './mobileUtils';
import OrganicPaperSoakTracker from '../OrganicPaperSoakTracker';
import { JsonDetailModal } from './JsonDetailModal';

export function MobileClosedTrades() {
  const closedTrades = useMobileMissionSelector((s) => s.closedTrades);
  const transactions = useMobileMissionSelector((s) => s.transactions);
  const [jsonOpen, setJsonOpen] = useState<{ title: string; data: unknown } | null>(null);

  const rows = closedTrades.length > 0 ? closedTrades : transactions.filter((t: any) => t.status === 'FILLED' || t.status === 'COMPLETED').slice(0, 10);

  return (
    <>
      <OrganicPaperSoakTracker />
      <section className="rounded-xl border border-slate-800 bg-[#111822] p-4">
        <div className="flex items-center gap-2 mb-3">
          <History size={16} className="text-amber-400" />
          <h2 className="text-xs font-mono uppercase tracking-widest text-slate-200">Closed trades</h2>
        </div>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="text-[10px] font-mono text-slate-500 py-4 text-center">No closed trades in REST snapshot.</p>
          ) : (
            rows.map((t: any, i: number) => (
              <button
                key={t.id || t.traceId || i}
                type="button"
                onClick={() => setJsonOpen({ title: `Trade ${t.symbol || t.id}`, data: t })}
                className="w-full text-left min-h-[44px] flex items-center justify-between py-2 border-b border-slate-800/80 last:border-0"
              >
                <div>
                  <p className="text-sm font-mono font-bold text-white">{t.symbol ?? '--'}</p>
                  <p className="text-[10px] font-mono text-slate-500">{t.side ?? t.finalDecision ?? t.status}</p>
                </div>
                <div className="text-right">
                  <p className={`text-xs font-mono ${(t.profitLoss ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {t.profitLoss != null ? fmtUsd(t.profitLoss) : '--'}
                  </p>
                  <p className="text-[9px] font-mono text-slate-600">{truncateText(String(t.openedAt || t.timestamp || ''), 16)}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </section>
      <JsonDetailModal
        open={jsonOpen != null}
        title={jsonOpen?.title || 'Trade'}
        data={jsonOpen?.data}
        onClose={() => setJsonOpen(null)}
      />
    </>
  );
}
