import { useEffect, useRef } from 'react';
import { useMotionValue, useSpring, useTransform } from 'motion/react';

/**
 * AnimatedNumber — tweened KPI display.
 *
 * Instead of jumping between values on each poll, the displayed number
 * springs toward the new value (~0.5s, critically-damped-ish). Used for
 * portfolio valuation, P&L, and other live metrics where abrupt jumps
 * look broken and mask real movement.
 *
 * Updates via textContent (no re-render per frame). Respects
 * prefers-reduced-motion by snapping.
 */
export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const mv = useMotionValue(value);
  const spring = useSpring(mv, { stiffness: 140, damping: 22, mass: 0.9 });
  const text = useTransform(spring, (v) =>
    format ? format(v) : v.toLocaleString('en-US'),
  );
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (reduceMotion) {
      mv.jump(value);
    } else {
      mv.set(value);
    }
  }, [value, mv, reduceMotion]);

  useEffect(() => {
    const unsub = text.on('change', (t) => {
      if (ref.current) ref.current.textContent = t;
    });
    return unsub;
  }, [text]);

  return (
    <span ref={ref} className={className}>
      {format ? format(value) : value.toLocaleString('en-US')}
    </span>
  );
}
