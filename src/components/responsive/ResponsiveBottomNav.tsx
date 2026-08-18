import React from 'react';
import { Menu } from 'lucide-react';
import type { AppTabId } from './responsiveNavConfig';
import { NAV_DOMAINS, domainForTab, tabDef } from './responsiveNavConfig';
import { NavDomainTooltip } from './NavTabTooltip';

export type ResponsiveBottomNavProps = {
  activeTab: AppTabId;
  onSelectTab: (tab: AppTabId) => void;
  onOpenDrawer: () => void;
  /** Sticky emergency kill switch */
  onEmergencyStop?: () => void;
  enginesHalted?: boolean;
  tradingMode?: string;
};

export function ResponsiveBottomNav({
  activeTab,
  onSelectTab,
  onOpenDrawer,
  onEmergencyStop,
  enginesHalted,
  tradingMode,
}: ResponsiveBottomNavProps) {
  const activeDomain = domainForTab(activeTab);

  return (
    <nav
      className="argus-compact-only fixed bottom-0 left-0 right-0 z-[120] bg-[#1A1F2B]/98 backdrop-blur-md border-t border-slate-800 argus-bottom-nav"
      aria-label="Primary navigation"
    >
      <div className="flex items-stretch justify-around px-1 pt-1">
        {NAV_DOMAINS.map(({ id, label, icon: Icon, defaultTab }) => {
          const active = activeDomain === id;
          return (
            <React.Fragment key={id}>
              <NavDomainTooltip domain={id}>
                <button
                  type="button"
                  onClick={() => onSelectTab(activeDomain === id ? activeTab : defaultTab)}
                  className={`argus-touch-target flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[9px] font-mono uppercase tracking-wider transition-colors ${
                    active ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-300'
                  }`}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon size={18} strokeWidth={active ? 2.5 : 2} />
                  <span>{label}</span>
                </button>
              </NavDomainTooltip>
            </React.Fragment>
          );
        })}
        <NavDomainTooltip domain="more">
          <button
            type="button"
            onClick={onOpenDrawer}
            className="argus-touch-target flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[9px] font-mono uppercase tracking-wider text-slate-500 hover:text-slate-300"
            aria-label="Open all tabs"
          >
            <Menu size={18} />
            <span>More</span>
          </button>
        </NavDomainTooltip>
      </div>
      <div className="flex items-center justify-between px-3 py-1 border-t border-slate-800/80">
        <span
          className={`text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded border ${
            tradingMode === 'LIVE'
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
          }`}
        >
          {tradingMode ?? 'PAPER'}-MODE
        </span>
        {onEmergencyStop && (
          <button
            type="button"
            onClick={onEmergencyStop}
            className={`argus-touch-target px-3 py-1.5 rounded text-[9px] font-bold uppercase tracking-wider border transition-colors ${
              enginesHalted
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-rose-900/40 border-rose-500/40 text-rose-400 hover:bg-rose-900/60'
            }`}
          >
            {enginesHalted ? 'Resume' : 'Kill Switch'}
          </button>
        )}
        <span className="text-[9px] font-mono text-slate-500 truncate max-w-[40%]">
          {tabDef(activeTab)?.label ?? activeTab}
        </span>
      </div>
    </nav>
  );
}
