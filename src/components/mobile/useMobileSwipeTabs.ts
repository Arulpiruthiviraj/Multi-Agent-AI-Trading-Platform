import React, { useCallback, useRef } from 'react';
import { patchMobileMissionSnapshot } from './mobileMissionStore';
import { MOBILE_TABS, clampTabIndex, mobileTabIndex, type MobileTabId } from './mobileTabs';

const SWIPE_THRESHOLD_PX = 48;

/** Horizontal swipe between bottom-nav tabs on the main content area. */
export function useMobileSwipeTabs(activeTab: MobileTabId) {
  const startX = useRef(0);
  const startY = useRef(0);
  const tracking = useRef(false);

  const setTabByIndex = useCallback((index: number) => {
    const tab = MOBILE_TABS[clampTabIndex(index)];
    if (tab) patchMobileMissionSnapshot({ activeTab: tab.id });
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    tracking.current = true;
  }, []);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!tracking.current || e.changedTouches.length !== 1) return;
    tracking.current = false;
    const dx = e.changedTouches[0].clientX - startX.current;
    const dy = e.changedTouches[0].clientY - startY.current;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    const idx = mobileTabIndex(activeTab);
    if (dx < 0) setTabByIndex(idx + 1);
    else setTabByIndex(idx - 1);
  }, [activeTab, setTabByIndex]);

  return { onTouchStart, onTouchEnd, setTabByIndex };
}
