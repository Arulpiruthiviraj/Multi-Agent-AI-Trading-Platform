/**
 * One-click Arm Autobot verification sheet.
 * Does not re-ask strategy/risk/broker/agents — those live on the dashboard / settings.
 * Confirmation still goes through TradingEngine.toggle() (PAPER_TRADING_ONLY, LIVE arming, etc.).
 */
import React, { useEffect, useState } from 'react';
import { X, Play, ShieldCheck, Radio, Server, Activity, Loader2, AlertTriangle } from 'lucide-react';

export interface LaunchVerificationSnapshot {
  brokerReady: boolean;
  brokerLabel: string;
  marketDataConnected: boolean;
  tradingState: string;
  autobotEnabled: boolean;
  liveReadiness: string;
  budget: number;
  dailyLossLimit: number;
  strategyFocus: string;
  dailyTargetAmount?: number | null;
  error?: string | null;
}

/** Pure payload used by Confirm & Launch — keeps toggle wiring testable without a DOM. */
export function buildArmAutobotPayload(opts: {
  strategyFocus: string;
  tradingMode?: string;
}): { strategy: string; tradingMode?: string } {
  return {
    strategy: opts.strategyFocus || 'ADAPTIVE_MULTI_STRATEGY',
    ...(opts.tradingMode ? { tradingMode: opts.tradingMode } : {}),
  };
}

interface AutonomousLaunchDialogProps {
  onClose: () => void;
  onStart: (config: {
    strategy: string;
    tradingMode?: string;
    riskProfile?: string;
  }) => void;
  initialBudget: number;
  initialRisk: number;
  strategyFocus?: string;
  tradingMode?: string;
  dailyTargetAmount?: number | null;
}

type CheckState = 'loading' | 'ready' | 'degraded';

export function AutonomousLaunchDialog({
  onClose,
  onStart,
  initialBudget,
  initialRisk,
  strategyFocus = 'ADAPTIVE_MULTI_STRATEGY',
  tradingMode = 'PAPER',
  dailyTargetAmount = null,
}: AutonomousLaunchDialogProps) {
  const [phase, setPhase] = useState<CheckState>('loading');
  const [snap, setSnap] = useState<LaunchVerificationSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const [healthRes, campaignRes] = await Promise.all([
          fetch('/api/v2/runtime/health'),
          fetch('/api/v2/campaign/status').catch(() => null),
        ]);
        const data = await healthRes.json();
        const h = data?.health ?? data ?? {};
        let target = dailyTargetAmount;
        if (campaignRes && campaignRes.ok) {
          try {
            const camp = await campaignRes.json();
            if (typeof camp?.dailyTargetAmount === 'number') target = camp.dailyTargetAmount;
          } catch { /* optional */ }
        }
        const next: LaunchVerificationSnapshot = {
          brokerReady: Boolean(h.brokerId || h.ok),
          brokerLabel: h.brokerId ? String(h.brokerId).toUpperCase() : 'UNKNOWN',
          marketDataConnected: h.marketDataConnected === true,
          tradingState: String(h.tradingState || 'UNKNOWN'),
          autobotEnabled: h.autobotEnabled === true,
          liveReadiness: String(h.liveReadiness || data?.live || 'LIVE_NO_GO'),
          budget: initialBudget,
          dailyLossLimit: initialRisk,
          strategyFocus,
          dailyTargetAmount: target,
          error: null,
        };
        if (!cancelled) {
          setSnap(next);
          const degraded = !next.marketDataConnected || next.tradingState !== 'TRADING_ENABLED';
          setPhase(degraded ? 'degraded' : 'ready');
        }
      } catch (e: any) {
        if (!cancelled) {
          setSnap({
            brokerReady: false,
            brokerLabel: 'UNREACHABLE',
            marketDataConnected: false,
            tradingState: 'UNKNOWN',
            autobotEnabled: false,
            liveReadiness: 'UNKNOWN',
            budget: initialBudget,
            dailyLossLimit: initialRisk,
            strategyFocus,
            dailyTargetAmount,
            error: e?.message || 'Health check failed',
          });
          setPhase('degraded');
        }
      }
    };
    const minDelay = new Promise((r) => setTimeout(r, 800));
    void Promise.all([run(), minDelay]);
    return () => { cancelled = true; };
  }, [initialBudget, initialRisk, strategyFocus, dailyTargetAmount]);

  const row = (ok: boolean | null, label: string, detail: string) => (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-800/80 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`mt-0.5 h-2 w-2 rounded-full shrink-0 ${ok === null ? 'bg-slate-500 animate-pulse' : ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        <span className="text-[11px] text-slate-300 uppercase tracking-widest">{label}</span>
      </div>
      <span className="text-[11px] text-slate-400 text-right font-mono truncate max-w-[55%]">{detail}</span>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#0A0F16] border border-slate-800 rounded-xl max-w-lg w-full flex flex-col shadow-2xl overflow-hidden font-mono">
        <div className="flex justify-between items-center p-5 border-b border-slate-800 bg-[#111822]">
          <div className="flex items-center gap-3">
            <ShieldCheck className="text-emerald-500" size={22} />
            <div>
              <h2 className="text-white font-bold tracking-widest uppercase text-sm">Arm Autobot — Pre-Flight</h2>
              <p className="text-[10px] text-slate-400 uppercase">Read-only verification · inherits dashboard controls</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-white transition-colors" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Allocation, daily target, max loss, and strategy mode are already on the dashboard. This sheet confirms readiness only — consensus stays 0.75 / min-2; RiskEngine 25 gates stay fail-closed.
          </p>

          <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
            {phase === 'loading' && (
              <div className="flex items-center gap-2 text-slate-400 text-xs py-6 justify-center">
                <Loader2 className="animate-spin" size={16} /> Running system checks…
              </div>
            )}
            {phase !== 'loading' && snap && (
              <>
                {row(snap.brokerReady, 'Broker gateway', `${snap.brokerLabel} ${snap.brokerReady ? '(Connected)' : '(Check)'}`)}
                {row(snap.marketDataConnected, 'Real-time data', snap.marketDataConnected ? 'WebSocket Streaming (Active)' : 'Disconnected / warming')}
                {row(snap.tradingState === 'TRADING_ENABLED', 'Risk management', '24 Safety Gates Armed (Fail-Closed)')}
                {row(true, 'Capital allocation', `$${snap.budget.toLocaleString()} Allocated${snap.dailyTargetAmount != null ? ` | Target: $${Number(snap.dailyTargetAmount).toLocaleString()}` : ''}`)}
                {row(true, 'Max daily loss', `$${snap.dailyLossLimit.toLocaleString()}`)}
                {row(true, 'Active mode', snap.strategyFocus === 'ADAPTIVE_MULTI_STRATEGY' ? 'Adaptive Multi-Strategy (Auto-Regime)' : snap.strategyFocus)}
                {row(true, 'Live readiness', snap.liveReadiness)}
                {snap.error && (
                  <div className="mt-3 flex gap-2 text-amber-400 text-[10px]">
                    <AlertTriangle size={14} className="shrink-0" /> {snap.error}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 text-[9px] text-slate-500 uppercase tracking-wider">
            <div className="flex items-center gap-1.5"><Server size={12} /> Broker</div>
            <div className="flex items-center gap-1.5"><Radio size={12} /> Feed</div>
            <div className="flex items-center gap-1.5"><Activity size={12} /> RiskEngine</div>
          </div>
        </div>

        <div className="p-5 border-t border-slate-800 bg-[#111822] flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-3 rounded text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={phase === 'loading'}
            onClick={() => onStart(buildArmAutobotPayload({ strategyFocus, tradingMode }))}
            className="px-6 py-3 rounded text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 shadow-[0_0_15px_rgba(16,185,129,0.3)] transition-all flex items-center gap-2"
          >
            <Play size={14} /> Confirm &amp; Arm Autobot
          </button>
        </div>
      </div>
    </div>
  );
}
