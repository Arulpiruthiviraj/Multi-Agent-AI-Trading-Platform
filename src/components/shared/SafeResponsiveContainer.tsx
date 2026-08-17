/**
 * ==========================================================
 * COMPONENT: SafeResponsiveContainer
 *
 * Recharts ResponsiveContainer initializes measured size as -1×-1 before
 * ResizeObserver runs. That logs "width(-1) and height(-1) of chart should be
 * greater than 0" on first paint (and again for flex/grid parents that collapse).
 *
 * Do not mount a Recharts chart until the parent has a real positive box, and
 * inject numeric width/height so ResponsiveContainer never renders at -1.
 * ==========================================================
 */
import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement } from 'react';

const MIN_CHART_SIZE = 1;

export function SafeResponsiveContainer({
  children,
  minWidth = MIN_CHART_SIZE,
  minHeight = MIN_CHART_SIZE,
}: {
  children: ReactElement;
  minWidth?: number;
  minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setBox(width >= minWidth && height >= minHeight ? { width, height } : null);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [minWidth, minHeight]);

  return (
    <div ref={ref} className="h-full w-full min-h-0 min-w-0">
      {box
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
            width: box.width,
            height: box.height,
          })
        : null}
    </div>
  );
}
