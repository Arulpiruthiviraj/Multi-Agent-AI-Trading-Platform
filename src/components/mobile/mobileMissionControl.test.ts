import { describe, it, expect } from 'vitest';
import { fmtUsd, fmtPct, truncateText, sessionChipClass, modeChipClass, MOBILE_BREAKPOINT_PX } from './mobileUtils';
import { MOBILE_TABS, mobileTabIndex, clampTabIndex } from './mobileTabs';
import riskGateOrder from '../../../config/riskGateOrder.json';

describe('mobileUtils', () => {
  it('fmtUsd returns -- for missing values', () => {
    expect(fmtUsd(null)).toBe('--');
    expect(fmtUsd(undefined)).toBe('--');
    expect(fmtUsd(NaN)).toBe('--');
  });

  it('fmtUsd formats finite numbers', () => {
    expect(fmtUsd(1234.5)).toContain('1,234.50');
  });

  it('fmtPct scales fractions to percent strings', () => {
    expect(fmtPct(0.153)).toBe('15.3%');
    expect(fmtPct(null)).toBe('--');
  });

  it('truncateText respects max length', () => {
    expect(truncateText('hello world', 5)).toBe('hello…');
    expect(truncateText('hi', 10)).toBe('hi');
  });

  it('chip classes distinguish LIVE vs PAPER', () => {
    expect(modeChipClass('LIVE')).toContain('rose');
    expect(modeChipClass('PAPER')).toContain('emerald');
  });

  it('sessionChipClass covers open session', () => {
    expect(sessionChipClass('MARKET_OPEN')).toContain('emerald');
    expect(sessionChipClass('CLOSED')).toContain('slate');
  });

  it('mobile breakpoint matches spec (768px)', () => {
    expect(MOBILE_BREAKPOINT_PX).toBe(768);
  });

  it('risk gate catalog has 25 entries for monitor UI (25th added 2026-09-05: extended_hours_execution_policy)', () => {
    expect(riskGateOrder.gates.length).toBe(25);
  });

  it('mobile tabs define 6 core views including settings', () => {
    expect(MOBILE_TABS).toHaveLength(6);
    expect(MOBILE_TABS.map((t) => t.id)).toEqual(['cockpit', 'positions', 'brain', 'risk', 'terminal', 'settings']);
    expect(mobileTabIndex('brain')).toBe(2);
    expect(clampTabIndex(99)).toBe(5);
  });
});
