import { useEffect, useRef, useState } from 'react';

/**
 * PriceFlash — Bloomberg-style tick flash for price cells.
 *
 * When `value` changes, briefly tints the background green (up) or red
 * (down), fading out over ~0.9s. Direction is derived from the numeric
 * delta, so a caller just renders the formatted price inside.
 *
 * Respects prefers-reduced-motion: no flash, value still updates.
 * Pure CSS animation — no per-frame JS, no re-render loop.
 */
export function PriceFlash({
  value,
  children,
  className = '',
}: {
  /** Numeric value used only for direction detection (null/NaN = no flash). */
  value: number | null;
  /** Formatted price content to render. */
  children: React.ReactNode;
  className?: string;
}) {
  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    if (reduceMotion) return;
    if (prev === null || value === null || !Number.isFinite(prev) || !Number.isFinite(value)) return;
    if (value === prev) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    // Re-trigger the CSS animation by toggling the class on the next frame.
    setFlash(null);
    requestAnimationFrame(() => {
      setFlash(value > (prev as number) ? 'up' : 'down');
      timerRef.current = setTimeout(() => setFlash(null), 950);
    });
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, reduceMotion]);

  const flashClass = flash === 'up' ? 'price-flash-up' : flash === 'down' ? 'price-flash-down' : '';
  return (
    <span className={`${className} ${flashClass}`.trim()}>
      {children}
    </span>
  );
}
