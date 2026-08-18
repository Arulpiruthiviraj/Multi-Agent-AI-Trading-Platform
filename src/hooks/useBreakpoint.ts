import { useEffect, useState } from 'react';
import {
  BREAKPOINT_LG_PX,
  BREAKPOINT_MD_PX,
  BREAKPOINT_SM_PX,
  type BreakpointName,
  breakpointFromWidth,
} from '../components/mobile/mobileUtils';

export type { BreakpointName };

export function useBreakpoint(): BreakpointName {
  const [bp, setBp] = useState<BreakpointName>(() =>
    typeof window !== 'undefined' ? breakpointFromWidth(window.innerWidth) : 'xl',
  );

  useEffect(() => {
    const queries: { name: BreakpointName; mq: MediaQueryList }[] = [
      { name: 'sm', mq: window.matchMedia(`(max-width: ${BREAKPOINT_SM_PX - 1}px)`) },
      { name: 'md', mq: window.matchMedia(`(min-width: ${BREAKPOINT_SM_PX}px) and (max-width: ${BREAKPOINT_MD_PX - 1}px)`) },
      { name: 'lg', mq: window.matchMedia(`(min-width: ${BREAKPOINT_MD_PX}px) and (max-width: ${BREAKPOINT_LG_PX - 1}px)`) },
      { name: 'xl', mq: window.matchMedia(`(min-width: ${BREAKPOINT_LG_PX}px)`) },
    ];

    const apply = () => setBp(breakpointFromWidth(window.innerWidth));
    apply();
    queries.forEach(({ mq }) => mq.addEventListener('change', apply));
    return () => queries.forEach(({ mq }) => mq.removeEventListener('change', apply));
  }, []);

  return bp;
}

/** Viewport narrower than lg (1024px) — tablet + phone compact chrome. */
export function useCompactNav(): boolean {
  const bp = useBreakpoint();
  return bp === 'sm' || bp === 'md' || bp === 'lg';
}

/** Viewport narrower than md (768px) — phone layouts (carousel, vertical pipeline). */
export function usePhoneLayout(): boolean {
  const bp = useBreakpoint();
  return bp === 'sm' || bp === 'md';
}
