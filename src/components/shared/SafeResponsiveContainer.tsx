/**
 * ==========================================================
 * COMPONENT: SafeResponsiveContainer
 *
 * Recharts ResponsiveContainer initializes measured size as -1×-1 before
 * ResizeObserver runs. That logs "width(-1) and height(-1) of chart should be
 * greater than 0" on first paint (and again for flex/grid parents that collapse).
 *
 * Mount the chart only after the parent has a real positive box, and pin
 * minWidth={0} so flex children can shrink without going negative.
 * ==========================================================
 */
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { ResponsiveContainer } from 'recharts';

export function SafeResponsiveContainer({ children }: { children: ReactElement }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setReady(el.clientWidth > 0 && el.clientHeight > 0);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="h-full w-full min-h-0 min-w-0">
      {ready ? (
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {children}
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}
