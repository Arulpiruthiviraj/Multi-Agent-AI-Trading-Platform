import React, { useRef, useState } from 'react';

interface MobilePullRefreshProps {
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
}

export function MobilePullRefresh({ onRefresh, children }: MobilePullRefreshProps) {
  const [pullY, setPullY] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const pulling = useRef(false);

  const onTouchStart = (e: React.TouchEvent) => {
    if (window.scrollY > 0 || refreshing) return;
    startY.current = e.touches[0].clientY;
    pulling.current = true;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!pulling.current || refreshing) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0) setPullY(Math.min(80, dy * 0.5));
  };

  const onTouchEnd = async () => {
    if (!pulling.current) return;
    pulling.current = false;
    if (pullY >= 56 && !refreshing) {
      setRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    }
    setPullY(0);
  };

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={() => { void onTouchEnd(); }}
      className="relative min-h-full"
    >
      {(pullY > 0 || refreshing) && (
        <div
          className="absolute left-0 right-0 top-0 flex justify-center text-[10px] font-mono uppercase tracking-widest text-slate-500 pointer-events-none z-10"
          style={{ height: pullY, paddingTop: Math.max(8, pullY - 24) }}
        >
          {refreshing ? 'Syncing…' : pullY >= 56 ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      )}
      <div style={{ transform: pullY ? `translateY(${pullY}px)` : undefined, transition: pullY ? 'none' : 'transform 0.2s ease' }}>
        {children}
      </div>
    </div>
  );
}
