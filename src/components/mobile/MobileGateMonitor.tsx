import React, { useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { fmtUsd } from './mobileUtils';
import tradingSafety from '../../../config/tradingSafety.json';

function LimitMeter({ label, current, max }: { label: string; current: number | null; max: number | null }) {
  if (current == null || max == null) {
    return <p className="text-[10px] font-mono text-slate-500">{label}: --</p>;
  }
  const pct = Math.min(100, Math.max(0, (Math.abs(current) / max) * 100));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] font-mono text-slate-400">
        <span>{label}</span>
        <span>{fmtUsd(current)} / {fmtUsd(max)}</span>
      </div>
      <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
        <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function MobileGateMonitor() {
  const gates = useMobileMissionSelector((s) => s.gates);
  const summary = useMobileMissionSelector((s) => s.gateSummary);
  const dailyLimits = useMobileMissionSelector((s) => s.dailyLimits);
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-xl border border-slate-800 bg-[#111822] p-4">
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck size={16} className="text-emerald-400" />
        <h2 className="text-xs font-mono uppercase tracking-widest text-slate-200">
          {gates.length}-gate monitor
        </h2>
      </div>

      <div className="flex gap-3 mb-3 text-[10px] font-mono uppercase">
        <span className="text-emerald-400">{summary.passed} pass</span>
        <span className="text-rose-400">{summary.failed} fail</span>
        <span className="text-slate-500">{summary.unknown} pending</span>
      </div>

      <div className="space-y-3 mb-3 border-b border-slate-800 pb-3">
        <LimitMeter label="Daily loss" current={dailyLimits.currentDailyLoss} max={dailyLimits.dailyLossLimit} />
        <LimitMeter
          label="Daily buy notional (paper cap)"
          current={dailyLimits.dailyBuyNotional}
          max={dailyLimits.maxDailyBuyNotional ?? tradingSafety.maxDailyBuyNotionalDollars}
        />
        {dailyLimits.dailyBuyNotional == null && (
          <p className="text-[9px] font-mono text-slate-600">Daily buy notional not exposed on REST — meter shows cap only.</p>
        )}
      </div>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full min-h-[44px] flex items-center justify-between px-3 rounded-lg border border-slate-800 text-[10px] font-mono uppercase tracking-wider text-slate-400"
      >
        Gate ladder
        <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
          {gates.map((g) => (
            <div key={g.name} className="flex items-center justify-between py-1.5 px-2 rounded border border-slate-800/60 text-[10px] font-mono">
              <span className="text-slate-400 truncate pr-2">{g.name.replace(/_/g, ' ')}</span>
              <span className={
                g.passed === true ? 'text-emerald-400' : g.passed === false ? 'text-rose-400' : 'text-slate-600'
              }>
                {g.passed === true ? 'PASS' : g.passed === false ? 'FAIL' : '--'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
