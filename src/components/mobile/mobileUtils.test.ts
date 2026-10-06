import { describe, it, expect } from 'vitest';
import {
  fmtUsd,
  fmtPct,
  truncateText,
  sessionChipClass,
  modeChipClass,
  breakpointFromWidth,
  isCompactViewport,
  isPhoneViewport,
  BREAKPOINT_SM_PX,
  BREAKPOINT_MD_PX,
  BREAKPOINT_LG_PX,
} from './mobileUtils';

/**
 * mobileUtils tests (2026-10-06). These formatters render money, percentages,
 * and session/mode indicators across Mobile Mission Control — wrong output here
 * is directly user-visible. The file's own mandate is "no fabricated values":
 * null/undefined/NaN must render as '--', never as $0.00 or 0%.
 */

describe('fmtUsd', () => {
  it('formats dollars with two decimals and thousands separators', () => {
    expect(fmtUsd(1234.5)).toBe('$1,234.50');
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(-50.25)).toBe('$-50.25');
  });

  it('renders missing or non-finite values as --, never a fabricated $0.00', () => {
    expect(fmtUsd(null)).toBe('--');
    expect(fmtUsd(undefined)).toBe('--');
    expect(fmtUsd(NaN)).toBe('--');
    expect(fmtUsd(Infinity)).toBe('--');
  });
});

describe('fmtPct', () => {
  it('formats a ratio as a percentage with one decimal by default', () => {
    expect(fmtPct(0.1234)).toBe('12.3%');
    expect(fmtPct(0)).toBe('0.0%');
    expect(fmtPct(-0.05)).toBe('-5.0%');
  });

  it('respects the digits parameter', () => {
    expect(fmtPct(0.1234, 2)).toBe('12.34%');
    expect(fmtPct(0.1234, 0)).toBe('12%');
  });

  it('renders missing or non-finite values as --, never a fabricated 0%', () => {
    expect(fmtPct(null)).toBe('--');
    expect(fmtPct(undefined)).toBe('--');
    expect(fmtPct(NaN)).toBe('--');
  });
});

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(truncateText('hello', 120)).toBe('hello');
  });

  it('truncates long text with an ellipsis, trimming trailing whitespace', () => {
    expect(truncateText('hello world foo', 11)).toBe('hello world…');
  });

  it('returns empty string for empty input', () => {
    expect(truncateText('')).toBe('');
  });
});

describe('sessionChipClass', () => {
  it('marks market-open sessions green', () => {
    expect(sessionChipClass('MARKET_OPEN')).toContain('emerald');
    expect(sessionChipClass('open')).toContain('emerald');
  });

  it('marks pre/after-hours sessions amber', () => {
    expect(sessionChipClass('PRE_MARKET')).toContain('amber');
    expect(sessionChipClass('AFTER_HOURS')).toContain('amber');
  });

  it('falls back to slate for unknown sessions - never crashes on unexpected input', () => {
    expect(sessionChipClass('SOMETHING_ELSE')).toContain('slate');
    expect(sessionChipClass('')).toContain('slate');
  });
});

describe('modeChipClass', () => {
  it('marks LIVE mode rose (danger) and PAPER mode emerald (safe)', () => {
    expect(modeChipClass('LIVE')).toContain('rose');
    expect(modeChipClass('PAPER')).toContain('emerald');
    expect(modeChipClass('live')).toContain('rose'); // case-insensitive
    expect(modeChipClass('paper')).toContain('emerald');
  });

  it('marks unknown modes amber (caution)', () => {
    expect(modeChipClass('SIMULATOR')).toContain('amber');
    expect(modeChipClass('')).toContain('amber');
  });
});

describe('breakpoint helpers', () => {
  it('breakpointFromWidth maps widths to Tailwind-aligned breakpoints', () => {
    expect(breakpointFromWidth(0)).toBe('sm');
    expect(breakpointFromWidth(BREAKPOINT_SM_PX - 1)).toBe('sm');
    expect(breakpointFromWidth(BREAKPOINT_SM_PX)).toBe('md');
    expect(breakpointFromWidth(BREAKPOINT_MD_PX)).toBe('lg');
    expect(breakpointFromWidth(BREAKPOINT_LG_PX)).toBe('xl');
    expect(breakpointFromWidth(9999)).toBe('xl');
  });

  it('isCompactViewport is true below the lg breakpoint', () => {
    expect(isCompactViewport(BREAKPOINT_LG_PX - 1)).toBe(true);
    expect(isCompactViewport(BREAKPOINT_LG_PX)).toBe(false);
  });

  it('isPhoneViewport is true below the md breakpoint', () => {
    expect(isPhoneViewport(BREAKPOINT_MD_PX - 1)).toBe(true);
    expect(isPhoneViewport(BREAKPOINT_MD_PX)).toBe(false);
  });
});
