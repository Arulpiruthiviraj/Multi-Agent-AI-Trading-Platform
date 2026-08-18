import React, { useCallback, useRef, useState } from 'react';

export type VirtualListProps<T> = {
  items: T[];
  itemHeight: number;
  maxHeight: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  className?: string;
  overscan?: number;
};

/** Lightweight fixed-height virtual list — no external deps. */
export function VirtualList<T>({
  items,
  itemHeight,
  maxHeight,
  renderItem,
  className = '',
  overscan = 3,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const totalHeight = items.length * itemHeight;
  const visibleCount = Math.ceil(maxHeight / itemHeight) + overscan * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(items.length, startIndex + visibleCount);
  const offsetY = startIndex * itemHeight;

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className={`argus-scroll-touch overflow-y-auto ${className}`}
      style={{ maxHeight }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {items.slice(startIndex, endIndex).map((item, i) => (
            <div key={startIndex + i} style={{ height: itemHeight }}>
              {renderItem(item, startIndex + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
