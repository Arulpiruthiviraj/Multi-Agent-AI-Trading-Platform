import React from 'react';
import { TrendingDown, Wallet } from 'lucide-react';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { fmtPct, fmtUsd } from './mobileUtils';

function Meter({ value, max, label }: { value: number | null; max: number | null; label: string }) {
  if (value == null || max == null || max <= 0) {
    return (
      <div className="text-[10px] font-mono text-slate-500">{label}: --</div>
    );
  }
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const tone = pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono uppercase tracking-wider text-slate-400">
        <span>{label}</span>
        <span className="text-slate-200">{fmtPct(value / max, 0)} of cap</span>
      </div>
      <div className="h-2 rounded bg-slate-800 overflow-hidden border border-slate-700">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function MobilePortfolioCard() {
  const portfolio = useMobileMissionSelector((s) => s.portfolio);
  const capital = useMobileMissionSelector((s) => s.capital);
  const settings = useMobileMissionSelector((s) => s.settings);
  const missionControl = useMobileMissionSelector((s) => s.missionControl);
  const errors = useMobileMissionSelector((s) => s.errors);

  const equity = portfolio?.equity ?? null;
  const cash = portfolio?.cash ?? null;
  const budget = settings?.budget ?? capital?.argusAllocated ?? null;
  const drawdown = portfolio?.drawdown ?? null;
  const maxDd = settings?.maxPortfolioDrawdownPct ?? null;
  const intradayPnl = capital?.dailyPnl ?? (missionControl as any)?.realizedPnlToday ?? null;
  const intradayReason = (missionControl as any)?.realizedPnlUnavailableReason as string | undefined;

  return (
    <section className="rounded-xl border border-slate-800/60 bg-slate-900/40 backdrop-blur-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <Wallet size={16} className="text-emerald-400" />
        <h2 className="text-xs font-mono uppercase tracking-widest text-slate-200">Portfolio</h2>
      </div>

      {errors.portfolio && (
        <p className="text-[10px] font-mono text-rose-400 mb-2">{errors.portfolio}</p>
      )}

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <p className="text-[9px] font-mono uppercase text-slate-500">Equity</p>
          <p className="text-lg font-bold font-mono text-white">{fmtUsd(equity)}</p>
        </div>
        <div>
          <p className="text-[9px] font-mono uppercase text-slate-500">Cash</p>
          <p className="text-lg font-bold font-mono text-white">{fmtUsd(cash)}</p>
        </div>
        <div>
          <p className="text-[9px] font-mono uppercase text-slate-500">Argus budget</p>
          <p className="text-sm font-mono text-indigo-300">{fmtUsd(budget)}</p>
        </div>
        <div>
          <p className="text-[9px] font-mono uppercase text-slate-500">Intraday P&amp;L</p>
          <p className={`text-sm font-mono ${intradayPnl != null && intradayPnl >= 0 ? 'text-emerald-400' : intradayPnl != null ? 'text-rose-400' : 'text-slate-500'}`}>
            {intradayPnl != null ? fmtUsd(intradayPnl) : '--'}
          </p>
          {intradayPnl == null && intradayReason && (
            <p className="text-[8px] text-slate-600 font-mono mt-0.5 leading-tight">{intradayReason.slice(0, 80)}…</p>
          )}
        </div>
      </div>

      <div className="flex items-start gap-2 border-t border-slate-800 pt-3">
        <TrendingDown size={14} className="text-amber-400 mt-0.5 shrink-0" />
        <div className="flex-1 space-y-2">
          <Meter
            value={drawdown}
            max={maxDd}
            label={`Drawdown vs max ${maxDd != null ? fmtPct(maxDd, 0) : '--'}`}
          />
          {capital?.unrealizedPnl != null && (
            <p className="text-[10px] font-mono text-slate-400">
              Unrealized: <span className="text-slate-200">{fmtUsd(capital.unrealizedPnl)}</span>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
