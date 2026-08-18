/** Shared formatting helpers for Mobile Mission Control — no fabricated values. */

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '--';
  return `${(v * 100).toFixed(digits)}%`;
}

export function truncateText(text: string, max = 120): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

export function sessionChipClass(session: string): string {
  if (session === 'MARKET_OPEN' || session === 'open') {
    return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40';
  }
  if (session === 'PRE_MARKET' || session === 'AFTER_HOURS' || session === 'pre_market' || session === 'after_hours') {
    return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
  }
  return 'bg-slate-700/40 text-slate-400 border-slate-600';
}

export function modeChipClass(mode: string): string {
  const m = mode.toUpperCase();
  if (m === 'LIVE') return 'bg-rose-500/10 border-rose-500/30 text-rose-400';
  if (m === 'PAPER') return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400';
  return 'bg-amber-500/10 border-amber-500/30 text-amber-400';
}

/** Tailwind-aligned breakpoints (px). sm <640, md 640–767, lg 768–1023, xl ≥1024. */
export const BREAKPOINT_SM_PX = 640;
export const BREAKPOINT_MD_PX = 768;
export const BREAKPOINT_LG_PX = 1024;

/** Legacy alias — matches md boundary (phone vs tablet+). */
export const MOBILE_BREAKPOINT_PX = BREAKPOINT_MD_PX;

export const MOBILE_LAYOUT_STORAGE_KEY = 'argus_mobile_layout_override';

export type MobileLayoutOverride = 'auto' | 'mobile' | 'desktop';

export type BreakpointName = 'sm' | 'md' | 'lg' | 'xl';

export function breakpointFromWidth(width: number): BreakpointName {
  if (width < BREAKPOINT_SM_PX) return 'sm';
  if (width < BREAKPOINT_MD_PX) return 'md';
  if (width < BREAKPOINT_LG_PX) return 'lg';
  return 'xl';
}

export function isCompactViewport(width: number): boolean {
  return width < BREAKPOINT_LG_PX;
}

export function isPhoneViewport(width: number): boolean {
  return width < BREAKPOINT_MD_PX;
}
