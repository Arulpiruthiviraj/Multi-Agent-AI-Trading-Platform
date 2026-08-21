/**
 * Goal-oriented daily campaign card — operator knobs + progress + strategy attribution.
 * Does not place orders. Campaign soft-lock only affects NEW BUY idea generation.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Target, Lock, Shield, TrendingUp } from 'lucide-react';
import { UnavailableHint } from '../UnavailableHint';

type CampaignBadge = 'PURSUING GOAL' | 'TARGET LOCKED' | 'CAPITAL PRESERVED' | 'DISABLED';

const UNATTRIBUTED_STRATEGY_ID = 'UNATTRIBUTED';

interface StrategyRow {
  quantStrategyId: string;
  realizedPnl: number;
  unrealizedPnl: number;
  tradesCount: number;
  winsCount: number;
  lossesCount: number;
}

interface CampaignStatus {
  ok?: boolean;
  enabled: boolean;
  tradingDate: string;
  budget: number;
  dailyTargetAmount: number;
  dailyTargetType: 'DOLLAR' | 'PERCENT';
  targetAchievedAction: 'LOCK_AND_IDLE' | 'TRAIL_STOPS_ONLY' | 'CONTINUE';
  targetDollars: number;
  dailyRealized: number;
  dailyUnrealized: number;
  dailyTotal: number;
  progress: number;
  buyLocked: boolean;
  badge: CampaignBadge;
  strategies: StrategyRow[];
  deployedCapital: number;
  idleCapital: number;
  capitalUtilizationPct: number;
  disclaimer?: string;
}

const badgeStyles: Record<CampaignBadge, string> = {
  'PURSUING GOAL': 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  'TARGET LOCKED': 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  'CAPITAL PRESERVED': 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30',
  DISABLED: 'text-slate-400 bg-slate-800/60 border-slate-700',
};

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

export function GoalCampaignCard() {
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [targetDraft, setTargetDraft] = useState('');
  const [typeDraft, setTypeDraft] = useState<'DOLLAR' | 'PERCENT'>('DOLLAR');
  const [actionDraft, setActionDraft] = useState<'LOCK_AND_IDLE' | 'TRAIL_STOPS_ONLY' | 'CONTINUE'>('CONTINUE');
  const [enabledDraft, setEnabledDraft] = useState(false);

  const applyStatus = useCallback((s: CampaignStatus) => {
    setStatus(s);
    setBudgetDraft(String(s.budget ?? ''));
    setTargetDraft(String(s.dailyTargetAmount ?? ''));
    setTypeDraft(s.dailyTargetType === 'PERCENT' ? 'PERCENT' : 'DOLLAR');
    setActionDraft(s.targetAchievedAction || 'CONTINUE');
    setEnabledDraft(!!s.enabled);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/campaign/status');
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setError(data.error || 'Failed to load campaign status');
        return;
      }
      setError(null);
      applyStatus(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to load campaign status');
    }
  }, [applyStatus]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/v2/campaign/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignEnabled: enabledDraft,
          budget: Number(budgetDraft),
          dailyTargetAmount: Number(targetDraft),
          dailyTargetType: typeDraft,
          targetAchievedAction: actionDraft,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setError(data.error || 'Failed to save campaign settings');
        return;
      }
      applyStatus(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to save campaign settings');
    } finally {
      setSaving(false);
    }
  };

  const progressPct = Math.max(0, Math.min(100, (status?.progress ?? 0) * 100));
  const badge = status?.badge ?? 'DISABLED';

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm relative overflow-hidden">
      <div className="absolute -top-10 -right-10 w-40 h-40 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />

      <div className="flex items-start justify-between gap-4 mb-4 relative z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            <Target className="text-emerald-400" size={20} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white tracking-wide uppercase">Daily Goal Campaign</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              NY session {status?.tradingDate ?? '—'} · attribution by quant strategy
            </p>
          </div>
        </div>
        <span className={`text-[10px] font-mono px-2 py-1 rounded border tracking-widest uppercase flex items-center gap-1.5 ${badgeStyles[badge]}`}>
          {badge === 'TARGET LOCKED' ? <Lock size={10} /> : badge === 'CAPITAL PRESERVED' ? <Shield size={10} /> : <TrendingUp size={10} />}
          {badge}
        </span>
      </div>

      <div className="mb-4 relative z-10">
        <div className="flex justify-between text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1.5">
          <span>Progress</span>
          <span className="text-emerald-400 font-mono">
            {formatUsd(status?.dailyTotal ?? 0)} / {formatUsd(status?.targetDollars ?? 0)} ({progressPct.toFixed(0)}%)
          </span>
        </div>
        <div className="h-2.5 rounded-full bg-slate-900 border border-slate-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.45)] transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="flex gap-4 mt-2 text-[10px] text-slate-500 font-mono">
          <span>Realized {formatUsd(status?.dailyRealized ?? 0)}</span>
          <span>Unrealized {formatUsd(status?.dailyUnrealized ?? 0)}</span>
        </div>
      </div>

      <div className="mb-4 relative z-10">
        <div className="flex justify-between text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1.5">
          <UnavailableHint
            reason="Deployed = local open positions + pending BUY orders, same math as the argus_capital_allocation risk gate. Display only — never used to size or force a trade."
            className="border-slate-700"
          >
            <span>Capital deployment</span>
          </UnavailableHint>
          <span className="text-slate-400 font-mono">
            {formatUsd(status?.deployedCapital ?? 0)} deployed · {formatUsd(status?.idleCapital ?? 0)} idle ({(status?.capitalUtilizationPct ?? 0).toFixed(0)}%)
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-slate-900 border border-slate-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-slate-500 transition-all duration-500"
            style={{ width: `${Math.max(0, Math.min(100, status?.capitalUtilizationPct ?? 0))}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4 relative z-10">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Allocated fund</span>
          <input
            type="number"
            value={budgetDraft}
            onChange={(e) => setBudgetDraft(e.target.value)}
            className="bg-[#0A0F16] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Daily target</span>
          <div className="flex gap-2">
            <input
              type="number"
              value={targetDraft}
              onChange={(e) => setTargetDraft(e.target.value)}
              className="flex-1 bg-[#0A0F16] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
            />
            <select
              value={typeDraft}
              onChange={(e) => setTypeDraft(e.target.value as 'DOLLAR' | 'PERCENT')}
              className="bg-[#0A0F16] border border-slate-700 rounded-lg px-2 py-2 text-xs text-slate-300"
            >
              <option value="DOLLAR">$</option>
              <option value="PERCENT">%</option>
            </select>
          </div>
        </label>
        <label className="flex flex-col gap-1 col-span-2">
          <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">On target reached</span>
          <select
            value={actionDraft}
            onChange={(e) => setActionDraft(e.target.value as typeof actionDraft)}
            className="bg-[#0A0F16] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200"
          >
            <option value="CONTINUE">CONTINUE — track only</option>
            <option value="LOCK_AND_IDLE">LOCK_AND_IDLE — soft-block new BUYs</option>
            <option value="TRAIL_STOPS_ONLY">TRAIL_STOPS_ONLY — soft-block BUYs; exits via PortfolioMonitor trail</option>
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between gap-3 mb-4 relative z-10">
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={enabledDraft}
            onChange={(e) => setEnabledDraft(e.target.checked)}
            className="rounded border-slate-600"
          />
          Campaign enabled
        </label>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save campaign'}
        </button>
      </div>

      {error && (
        <div className="mb-3 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="relative z-10">
        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-2">Strategy breakdown</div>
        <div className="max-h-40 overflow-y-auto custom-scrollbar border border-slate-800 rounded-lg">
          <table className="w-full text-left text-[11px]">
            <thead className="bg-[#0A0F16] text-slate-500 sticky top-0">
              <tr>
                <th className="px-3 py-2 font-bold">Strategy</th>
                <th className="px-3 py-2 font-bold">Trades</th>
                <th className="px-3 py-2 font-bold">W/L</th>
                <th className="px-3 py-2 font-bold">Realized</th>
                <th className="px-3 py-2 font-bold">Unrealized</th>
              </tr>
            </thead>
            <tbody>
              {(status?.strategies?.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-slate-600 text-center">
                    No attributed fills today
                  </td>
                </tr>
              ) : (
                status!.strategies.map((row) => (
                  <tr key={row.quantStrategyId} className="border-t border-slate-800/80 text-slate-300 font-mono">
                    <td className="px-3 py-2 text-slate-200">
                      {row.quantStrategyId === UNATTRIBUTED_STRATEGY_ID ? (
                        <UnavailableHint reason="No Argus quant strategy tagged the opening BUY for this fill (e.g. a position synced in from the broker rather than opened by an Argus strategy).">
                          {row.quantStrategyId}
                        </UnavailableHint>
                      ) : (
                        row.quantStrategyId
                      )}
                    </td>
                    <td className="px-3 py-2">{row.tradesCount}</td>
                    <td className="px-3 py-2">{row.winsCount}/{row.lossesCount}</td>
                    <td className={`px-3 py-2 ${row.realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {formatUsd(row.realizedPnl)}
                    </td>
                    <td className={`px-3 py-2 ${row.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {formatUsd(row.unrealizedPnl)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-4 text-[10px] text-slate-600 leading-relaxed relative z-10">
        {status?.disclaimer
          || 'Campaign does not bypass RiskEngine, OMS, or ChiefTrader consensus. LOCK_AND_IDLE only soft-blocks new BUY ideas; SELL/exits still run when TRADING_ENABLED.'}
      </p>
    </div>
  );
}
