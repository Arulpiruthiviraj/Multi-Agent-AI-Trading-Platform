import React from 'react';
import { X } from 'lucide-react';
import type { AppTabId } from './responsiveNavConfig';
import { ALL_TABS, NAV_DOMAINS } from './responsiveNavConfig';
import { NavTabTooltip } from './NavTabTooltip';
import { NAV_TAB_TOOLTIPS } from './navTabTooltips';

export type ResponsiveNavDrawerProps = {
  open: boolean;
  activeTab: AppTabId;
  onClose: () => void;
  onSelectTab: (tab: AppTabId) => void;
};

export function ResponsiveNavDrawer({ open, activeTab, onClose, onSelectTab }: ResponsiveNavDrawerProps) {
  if (!open) return null;

  const handleSelect = (tab: AppTabId) => {
    onSelectTab(tab);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[130] flex" role="dialog" aria-modal="true" aria-label="All tabs">
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        aria-label="Close menu"
        onClick={onClose}
      />
      <aside
        className="relative ml-auto w-[min(320px,88vw)] h-full bg-[#1A1F2B] border-l border-slate-700 shadow-2xl flex flex-col argus-scroll-touch"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-white font-bold">All Desks</h2>
          <button
            type="button"
            onClick={onClose}
            className="argus-touch-target flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-400"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-5">
          {NAV_DOMAINS.map(({ id, label }) => {
            const tabs = ALL_TABS.filter((t) => t.domain === id);
            return (
              <section key={id}>
                <h3 className="text-[9px] font-mono uppercase tracking-widest text-slate-500 mb-2 px-1">
                  {label}
                </h3>
                <ul className="space-y-1">
                  {tabs.map(({ id: tabId, label: tabLabel, icon: Icon }) => (
                    <li key={tabId}>
                      <NavTabTooltip tabId={tabId} className="block w-full">
                        <button
                          type="button"
                          onClick={() => handleSelect(tabId)}
                          className={`w-full argus-touch-target flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-[11px] font-mono transition-colors ${
                            activeTab === tabId
                              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                              : 'text-slate-300 hover:bg-slate-800/80 border border-transparent'
                          }`}
                        >
                          <Icon size={16} className="shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="uppercase tracking-wide block">{tabLabel}</span>
                            <span className="block text-[9px] font-sans normal-case tracking-normal text-slate-500 leading-snug mt-0.5 line-clamp-2">
                              {NAV_TAB_TOOLTIPS[tabId].purpose}
                            </span>
                          </span>
                        </button>
                      </NavTabTooltip>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
