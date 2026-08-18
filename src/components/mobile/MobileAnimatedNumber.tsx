import React, { useEffect, useRef, useState } from 'react';
import { fmtUsd } from './mobileUtils';

interface MobileAnimatedNumberProps {
  value: number | null;
  format?: 'usd' | 'raw';
  decimals?: number;
  className?: string;
  durationMs?: number;
}

/** Tabular animated counter for equity/P&L — no fabricated values when null. */
export function MobileAnimatedNumber({
  value,
  format = 'usd',
  decimals = 2,
  className = '',
  durationMs = 320,
}: MobileAnimatedNumberProps) {
  const [display, setDisplay] = useState<number | null>(value);
  const fromRef = useRef<number | null>(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (value == null || !Number.isFinite(value)) {
      setDisplay(null);
      fromRef.current = null;
      return;
    }
    const from = fromRef.current ?? value;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      setDisplay(from + (value - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs]);

  if (display == null || !Number.isFinite(display)) {
    return <span className={`mobile-tabular ${className}`}>--</span>;
  }
  const text = format === 'usd'
    ? fmtUsd(display)
    : display.toFixed(decimals);
  return <span className={`mobile-tabular ${className}`}>{text}</span>;
}
