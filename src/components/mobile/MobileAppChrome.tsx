import React from 'react';
import { AlertOctagon, Info, TrendingUp, Wifi } from 'lucide-react';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { modeChipClass, sessionChipClass } from './mobileUtils';
import { MOBILE_TABS, type MobileTabId } from './mobileTabs';
import { patchMobileMissionSnapshot } from './mobileMissionStore';
import { MobileNavTabTooltip } from '../responsive/NavTabTooltip';

interface MobileTopBarProps {
  onKillTap: () => void;
  onInfoTap: () => void;
}

function sessionShortLabel(session: string): string {
  if (session === 'MARKET_OPEN' || session === 'open') return 'RTH OPEN';
  if (session === 'PRE_MARKET' || session === 'pre_market') return 'PRE';
  if (session === 'AFTER_HOURS' || session === 'after_hours') return 'AH';
  if (session === 'WEEKEND_CLOSED') return 'WEEKEND';
  return session === 'UNKNOWN' ? '—' : 'CLOSED';
}

export function MobileTopBar({ onKillTap, onInfoTap }: MobileTopBarProps) {
  const tradingMode = useMobileMissionSelector((s) => s.tradingMode);
  const marketSession = useMobileMissionSelector((s) => s.marketSession);
  const wsStatus = useMobileMissionSelector((s) => s.wsStatus);
  const wsLatencyMs = useMobileMissionSelector((s) => s.wsLatencyMs);
  const emergencyStopActive = useMobileMissionSelector((s) => s.emergencyStopActive);

  return (
    <header
      className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#070a12]/90 backdrop-blur-md"
      style={{ paddingTop: 'env(safe-area-inset-top)', minHeight: 'var(--mobile-top-h)' }}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0 mobile-glow-emerald">
            <TrendingUp size={16} className="text-emerald-400" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-white tracking-tight truncate">Argus</p>
            <p className="text-[8px] font-mono uppercase tracking-[0.2em] text-slate-500">Mission Control</p>
          </div>
        </div>

        <div className="flex items-center gap-1 flex-wrap justify-end">
          <span className={`text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border ${modeChipClass(tradingMode)}`}>
            {tradingMode}
          </span>
          <span className={`text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border ${sessionChipClass(marketSession)}`}>
            {sessionShortLabel(marketSession)}
          </span>
          <span className="text-[8px] font-mono text-slate-400 flex items-center gap-0.5">
            <Wifi size={10} className={wsStatus === 'connected' ? 'text-emerald-400' : 'text-amber-400'} />
            {wsLatencyMs == null ? '--' : `${wsLatencyMs}`}ms
          </span>
          <button
            type="button"
            aria-label="How Argus works"
            onClick={onInfoTap}
            className="mobile-press min-h-[36px] min-w-[36px] rounded-lg border border-slate-700 bg-slate-800/60 flex items-center justify-center"
          >
            <Info size={16} className="text-cyan-400" />
          </button>
          <button
            type="button"
            aria-label="Emergency kill switch"
            onClick={onKillTap}
            className={`mobile-press min-h-[36px] min-w-[36px] rounded-lg border flex items-center justify-center ${
              emergencyStopActive
                ? 'border-rose-500 bg-rose-500/20 mobile-glow-crimson'
                : 'border-rose-500/40 bg-rose-500/10'
            }`}
          >
            <AlertOctagon size={16} className="text-rose-400" />
          </button>
        </div>
      </div>
    </header>
  );
}

export function MobileBottomNav() {
  const activeTab = useMobileMissionSelector((s) => s.activeTab);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-800/80 bg-[#070a12]/95 backdrop-blur-md"
      style={{
        paddingBottom: 'env(safe-area-inset-bottom)',
        height: 'var(--mobile-nav-h)',
      }}
    >
      <div className="flex items-stretch justify-around h-[56px] w-full max-w-lg mx-auto overflow-hidden">
        {MOBILE_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <React.Fragment key={tab.id}>
              <MobileNavTabTooltip tabId={tab.id}>
                <button
                  type="button"
                  onClick={() => patchMobileMissionSnapshot({ activeTab: tab.id as MobileTabId })}
                  className={`mobile-nav-item mobile-press flex flex-col items-center justify-center flex-1 min-w-0 gap-0.5 min-h-[44px] px-0.5 ${
                    active ? 'active' : 'text-slate-500'
                  }`}
                >
                  <Icon size={18} strokeWidth={active ? 2.5 : 2} />
                  <span className="text-[8px] font-mono uppercase tracking-wider truncate w-full text-center">{tab.shortLabel}</span>
                </button>
              </MobileNavTabTooltip>
            </React.Fragment>
          );
        })}
      </div>
    </nav>
  );
}
