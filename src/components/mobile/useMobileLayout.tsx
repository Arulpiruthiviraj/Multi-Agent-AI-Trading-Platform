import { useCallback, useEffect, useState } from 'react';
import { MOBILE_BREAKPOINT_PX, MOBILE_LAYOUT_STORAGE_KEY, type MobileLayoutOverride } from './mobileUtils';
import { patchMobileMissionSnapshot } from './mobileMissionStore';

function readOverride(): MobileLayoutOverride {
  try {
    const v = localStorage.getItem(MOBILE_LAYOUT_STORAGE_KEY);
    if (v === 'mobile' || v === 'desktop' || v === 'auto') return v;
  } catch { /* ignore */ }
  return 'auto';
}

export function useMobileLayout() {
  const [viewportMobile, setViewportMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT_PX,
  );
  const [override, setOverrideState] = useState<MobileLayoutOverride>(readOverride);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const apply = () => {
      const mobile = mq.matches;
      setViewportMobile(mobile);
      patchMobileMissionSnapshot({ viewportMobile: mobile, layoutOverride: override });
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [override]);

  useEffect(() => {
    patchMobileMissionSnapshot({ layoutOverride: override, viewportMobile });
  }, [override, viewportMobile]);

  const isMobileMode =
    override === 'mobile' || (override === 'auto' && viewportMobile);

  const setOverride = useCallback((next: MobileLayoutOverride) => {
    setOverrideState(next);
    try {
      localStorage.setItem(MOBILE_LAYOUT_STORAGE_KEY, next);
    } catch { /* ignore */ }
    patchMobileMissionSnapshot({ layoutOverride: next });
  }, []);

  const toggleMobileView = useCallback(() => {
    if (isMobileMode) {
      setOverride('desktop');
    } else {
      setOverride(viewportMobile ? 'auto' : 'mobile');
    }
  }, [isMobileMode, viewportMobile, setOverride]);

  return {
    isMobileMode,
    viewportMobile,
    override,
    setOverride,
    toggleMobileView,
  };
}

export type MobileLayoutToggleProps = {
  isMobileMode: boolean;
  override: MobileLayoutOverride;
  onToggle: () => void;
};

export function MobileLayoutToggle({ isMobileMode, override, onToggle }: MobileLayoutToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="min-h-[44px] min-w-[44px] px-3 py-2 rounded border border-slate-700 bg-slate-800/80 text-[10px] font-mono uppercase tracking-wider text-slate-300 hover:border-indigo-500/40 hover:text-indigo-300 transition-colors"
      title="Toggle mobile mission control layout"
      aria-pressed={isMobileMode}
    >
      {isMobileMode ? 'Desktop' : 'Mobile'}
      {override !== 'auto' && (
        <span className="ml-1 text-[8px] text-slate-500">({override})</span>
      )}
    </button>
  );
}
