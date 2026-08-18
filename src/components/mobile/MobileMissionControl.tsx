/**
 * ARGUS Mobile PWA — 5-tab cyber-fintech remote cockpit.
 */
import React, { useState } from 'react';
import './mobileTheme.css';
import { MobileTopBar, MobileBottomNav } from './MobileAppChrome';
import { MobilePullRefresh } from './MobilePullRefresh';
import { useMobileMissionData, triggerEmergencyStop } from './useMobileMissionData';
import { useMobileWsResume } from './useMobileWsResume';
import { useMobileMissionSelector } from './useMobileMissionSelector';
import { useMobileSwipeTabs } from './useMobileSwipeTabs';
import type { MobileTabId } from './mobileTabs';
import { MobileLayoutToggle } from './useMobileLayout';
import { MobileCockpitView } from './views/MobileCockpitView';
import { MobilePositionsView } from './views/MobilePositionsView';
import { MobileAiBrainView } from './views/MobileAiBrainView';
import { MobileRiskView } from './views/MobileRiskView';
import { MobileTerminalView } from './views/MobileTerminalView';
import { MobileBottomSheet } from './MobileBottomSheet';

interface MobileMissionControlProps {
  onToggleLayout: () => void;
  layoutOverride: import('./mobileUtils').MobileLayoutOverride;
  isMobileMode: boolean;
}

function MobileActiveView({ tab, onRefresh }: { tab: MobileTabId; onRefresh: () => void }) {
  switch (tab) {
    case 'cockpit': return <MobileCockpitView onRefresh={onRefresh} />;
    case 'positions': return <MobilePositionsView />;
    case 'brain': return <MobileAiBrainView />;
    case 'risk': return <MobileRiskView />;
    case 'terminal': return <MobileTerminalView />;
    default: return <MobileCockpitView onRefresh={onRefresh} />;
  }
}

export default function MobileMissionControl({
  onToggleLayout,
  layoutOverride,
  isMobileMode,
}: MobileMissionControlProps) {
  const { pullToRefresh, refresh } = useMobileMissionData(true);
  useMobileWsResume(true);
  const activeTab = useMobileMissionSelector((s) => s.activeTab);
  const refreshing = useMobileMissionSelector((s) => s.refreshing);
  const lastRefreshAt = useMobileMissionSelector((s) => s.lastRefreshAt);
  const { onTouchStart, onTouchEnd } = useMobileSwipeTabs(activeTab);
  const [killSheet, setKillSheet] = useState(false);

  return (
    <div
      className="min-h-[100dvh] flex flex-col overflow-hidden"
      id="mobile-mission-control"
      style={{
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      <MobileTopBar onKillTap={() => setKillSheet(true)} />

      <div className="px-3 py-1.5 flex items-center justify-between border-b border-slate-800/50 bg-[#070a12]/80 shrink-0">
        <MobileLayoutToggle isMobileMode={isMobileMode} override={layoutOverride} onToggle={onToggleLayout} />
        <span className="text-[9px] font-mono text-slate-600">
          {refreshing ? 'Syncing…' : lastRefreshAt ? new Date(lastRefreshAt).toLocaleTimeString() : '—'}
        </span>
      </div>

      <main
        className="flex-1 overflow-y-auto overscroll-contain"
        style={{ paddingBottom: 'var(--mobile-nav-h)' }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <MobilePullRefresh onRefresh={pullToRefresh}>
          <MobileActiveView tab={activeTab} onRefresh={() => { void refresh(); }} />
        </MobilePullRefresh>
      </main>

      <MobileBottomNav />

      <MobileBottomSheet open={killSheet} title="Quick kill" onClose={() => setKillSheet(false)} danger>
        <p className="text-sm text-slate-300 mb-4">Trigger emergency stop from the top bar.</p>
        <button
          type="button"
          onClick={() => {
            void triggerEmergencyStop().then(() => {
              setKillSheet(false);
              void refresh();
            });
          }}
          className="w-full min-h-[48px] rounded-lg bg-rose-700 text-white font-bold text-xs uppercase mobile-press"
        >
          Execute now
        </button>
      </MobileBottomSheet>
    </div>
  );
}
