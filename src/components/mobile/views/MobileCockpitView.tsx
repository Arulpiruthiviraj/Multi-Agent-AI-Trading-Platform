import React, { useMemo, useState } from 'react';
import { ChevronDown, Power, Zap } from 'lucide-react';
import { useMobileMissionSelector } from '../useMobileMissionSelector';
import { MobileAnimatedNumber } from '../MobileAnimatedNumber';
import { MobileGlassCard } from '../MobileGlassCard';
import { fmtUsd } from '../mobileUtils';
import { toggleAutobotRemote, triggerEmergencyStop } from '../useMobileMissionData';
import { MobileBottomSheet } from '../MobileBottomSheet';

interface MobileCockpitViewProps {
  onRefresh?: () => void;
}

function MiniSparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const w = 280;
  const h = 48;
  const d = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p - min) / range) * (h - 4) - 2;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-12 mt-2" preserveAspectRatio="none">
      <defs>
        <linearGradient id="mobileSparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="url(#mobileSparkGrad)" />
      <path d={d} fill="none" className="mobile-sparkline" strokeWidth="2" />
    </svg>
  );
}

function OrganicPaperRing({
  closed,
  sessions,
  minTrades,
  minSessions,
}: {
  closed: number | null;
  sessions: number | null;
  minTrades: number;
  minSessions: number;
}) {
  const tradePct = closed != null && minTrades > 0 ? Math.min(100, (closed / minTrades) * 100) : 0;
  const sessionPct = sessions != null && minSessions > 0 ? Math.min(100, (sessions / minSessions) * 100) : 0;
  const pct = Math.min(tradePct, sessionPct);
  const r = 36;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4">
      <svg width="88" height="88" viewBox="0 0 88 88" className="shrink-0">
        <circle cx="44" cy="44" r={r} fill="none" stroke="#1e293b" strokeWidth="6" />
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          stroke="#10b981"
          strokeWidth="6"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          strokeLinecap="round"
          transform="rotate(-90 44 44)"
        />
        <text x="44" y="48" textAnchor="middle" className="fill-emerald-400 text-[11px] font-mono font-bold">
          {pct.toFixed(0)}%
        </text>
      </svg>
      <div className="text-[10px] font-mono text-slate-400 space-y-1">
        <p>Paper soak floor</p>
        <p className="text-slate-200">{closed ?? '--'} / {minTrades} trades</p>
        <p className="text-slate-200">{sessions ?? '--'} / {minSessions} sessions</p>
      </div>
    </div>
  );
}

export function MobileCockpitView({ onRefresh }: MobileCockpitViewProps) {
  const portfolio = useMobileMissionSelector((s) => s.portfolio);
  const capital = useMobileMissionSelector((s) => s.capital);
  const settings = useMobileMissionSelector((s) => s.settings);
  const autobotEnabled = useMobileMissionSelector((s) => s.autobotEnabled);
  const emergencyStopActive = useMobileMissionSelector((s) => s.emergencyStopActive);
  const equityHistory = useMobileMissionSelector((s) => s.equityHistory);
  const organicPaper = useMobileMissionSelector((s) => s.organicPaper);
  const actionBanner = useMobileMissionSelector((s) => s.actionBanner);
  const sessionExpired = useMobileMissionSelector((s) => s.sessionExpired);
  const [allocOpen, setAllocOpen] = useState(false);
  const [killStep, setKillStep] = useState<0 | 1 | 2>(0);
  const [toggling, setToggling] = useState(false);

  const sparkPoints = useMemo(() => {
    return equityHistory
      .map((p) => p.equity ?? p.value)
      .filter((v): v is number => v != null && Number.isFinite(v))
      .slice(-48);
  }, [equityHistory]);

  const intradayPnl = capital?.dailyPnl ?? null;
  const equity = portfolio?.equity ?? null;

  const onToggle = async () => {
    setToggling(true);
    await toggleAutobotRemote(autobotEnabled);
    onRefresh?.();
    setToggling(false);
  };

  const onKill = async () => {
    const res = await triggerEmergencyStop();
    if (res.ok) {
      setKillStep(0);
      onRefresh?.();
    }
  };

  return (
    <div className="space-y-4 p-3">
      {sessionExpired && (
        <p className="text-[10px] font-mono text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          Session expired — please log in again.
        </p>
      )}
      {actionBanner && (
        <p className={`text-[10px] font-mono rounded-lg px-3 py-2 border ${
          actionBanner.tone === 'success' ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
            : 'text-rose-300 bg-rose-500/10 border-rose-500/40'
        }`}>
          {actionBanner.message}
        </p>
      )}

      <MobileGlassCard glow={autobotEnabled ? 'emerald' : 'none'} active={autobotEnabled} className="!p-5">
        <p className="text-[9px] font-mono uppercase tracking-[0.25em] text-slate-500 mb-1">Total equity</p>
        <MobileAnimatedNumber value={equity} className="text-3xl font-bold text-white block" />
        <div className="flex gap-2 mt-2 flex-wrap">
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
            intradayPnl != null && intradayPnl >= 0 ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' : 'text-rose-400 border-rose-500/40 bg-rose-500/10'
          }`}>
            {intradayPnl != null ? fmtUsd(intradayPnl) : '--'} today
          </span>
        </div>
        <MiniSparkline points={sparkPoints} />
        <button
          type="button"
          onClick={() => setAllocOpen(!allocOpen)}
          className="mt-3 w-full min-h-[44px] flex items-center justify-between text-[10px] font-mono uppercase text-slate-400 border-t border-slate-800/80 pt-3"
        >
          Allocation breakdown
          <ChevronDown size={14} className={`transition-transform ${allocOpen ? 'rotate-180' : ''}`} />
        </button>
        {allocOpen && (
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] font-mono">
            <div><span className="text-slate-500">Argus budget</span><p className="text-indigo-300">{fmtUsd(settings?.budget ?? capital?.argusAllocated ?? null)}</p></div>
            <div><span className="text-slate-500">Broker equity</span><p className="text-white">{fmtUsd(equity)}</p></div>
            <div><span className="text-slate-500">Cash</span><p className="text-white">{fmtUsd(portfolio?.cash ?? null)}</p></div>
            <div><span className="text-slate-500">Argus remaining</span><p className="text-cyan-400">{fmtUsd(capital?.argusRemaining ?? null)}</p></div>
          </div>
        )}
      </MobileGlassCard>

      <MobileGlassCard glow={autobotEnabled ? 'cyan' : 'none'} className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1">
            <Zap size={14} className="text-cyan-400" /> Autobot engine
          </p>
          <p className="text-sm font-bold text-white mt-1">{autobotEnabled ? 'RUNNING' : 'STANDBY'}</p>
        </div>
        <button
          type="button"
          disabled={toggling || emergencyStopActive}
          onClick={() => { void onToggle(); }}
          className={`mobile-press min-h-[52px] min-w-[100px] rounded-xl border-2 font-mono text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 ${
            autobotEnabled
              ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300 mobile-glow-emerald'
              : 'border-slate-700 bg-slate-800/80 text-slate-400'
          } ${toggling ? 'opacity-60 animate-pulse' : ''}`}
        >
          <Power size={18} className={toggling ? 'animate-spin' : ''} />
          {toggling ? '…' : autobotEnabled ? 'ON' : 'OFF'}
        </button>
      </MobileGlassCard>

      {organicPaper && (
        <MobileGlassCard>
          <p className="text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-3">Organic paper validation</p>
          <OrganicPaperRing
            closed={organicPaper.closedTradeCount}
            sessions={organicPaper.sessionCount}
            minTrades={organicPaper.minPaperTrades}
            minSessions={organicPaper.minPaperSessions}
          />
          {organicPaper.soakStatus && (
            <p className="text-[9px] font-mono text-slate-500 mt-2">{organicPaper.soakStatus}</p>
          )}
        </MobileGlassCard>
      )}

      <button
        type="button"
        onClick={() => setKillStep(1)}
        className="mobile-press w-full min-h-[52px] rounded-xl border-2 border-rose-500/50 bg-rose-500/10 text-rose-300 font-mono text-xs font-bold uppercase tracking-widest mobile-glow-crimson"
      >
        Emergency kill switch
      </button>

      <MobileBottomSheet open={killStep >= 1} title="Emergency halt" onClose={() => setKillStep(0)} danger>
        {killStep === 1 ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">Halts new entries via RiskEngine. Positions are not auto-flattened.</p>
            <button type="button" onClick={() => setKillStep(2)} className="w-full min-h-[44px] rounded-lg bg-rose-600 text-white font-bold text-xs uppercase">
              Continue
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => { void onKill(); }} className="w-full min-h-[48px] rounded-lg bg-rose-700 text-white font-bold text-xs uppercase border border-rose-400/50">
            Execute emergency stop
          </button>
        )}
      </MobileBottomSheet>
    </div>
  );
}
