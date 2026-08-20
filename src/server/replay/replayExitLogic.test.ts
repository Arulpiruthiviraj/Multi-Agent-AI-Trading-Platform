import { describe, it, expect } from 'vitest';
import { tradingSafety } from '../config/tradingSafety';
import { determineStopTargetExit, determineGenericExit } from './FullArgusReplayEngine';

describe('determineStopTargetExit', () => {
  it('fires STOP when the bar low touches or breaches the stop', () => {
    expect(determineStopTargetExit({ stop: 100, target: null }, { low: 99, high: 105 })).toBe('STOP');
    expect(determineStopTargetExit({ stop: 100, target: null }, { low: 100, high: 105 })).toBe('STOP');
  });

  it('fires TARGET when the bar high touches or exceeds the target', () => {
    expect(determineStopTargetExit({ stop: null, target: 120 }, { low: 110, high: 121 })).toBe('TARGET');
    expect(determineStopTargetExit({ stop: null, target: 120 }, { low: 110, high: 120 })).toBe('TARGET');
  });

  it('STOP takes priority over TARGET when a single bar range spans both', () => {
    expect(determineStopTargetExit({ stop: 100, target: 120 }, { low: 95, high: 125 })).toBe('STOP');
  });

  it('returns null when neither the stop nor the target is touched', () => {
    expect(determineStopTargetExit({ stop: 100, target: 120 }, { low: 105, high: 115 })).toBeNull();
  });

  it('returns null when both stop and target are null (no strategy-level exit configured)', () => {
    expect(determineStopTargetExit({ stop: null, target: null }, { low: 0, high: 1000 })).toBeNull();
  });
});

describe('determineGenericExit', () => {
  it('fires TAKE_PROFIT above the fallbackTakeProfitPct threshold, using the real config value', () => {
    const entry = 100;
    const justOver = entry * (1 + (tradingSafety.fallbackTakeProfitPct + 0.1) / 100);
    expect(determineGenericExit(entry, justOver)).toBe('TAKE_PROFIT');
  });

  it('does not fire at exactly the threshold (strictly greater than, matching PortfolioMonitor)', () => {
    const entry = 100;
    const atThreshold = entry * (1 + tradingSafety.fallbackTakeProfitPct / 100);
    expect(determineGenericExit(entry, atThreshold)).toBeNull();
  });

  it('fires HARD_STOP below the fallbackTrailingStopPct threshold, using the real config value', () => {
    const entry = 100;
    const justUnder = entry * (1 - (tradingSafety.fallbackTrailingStopPct + 0.1) / 100);
    expect(determineGenericExit(entry, justUnder)).toBe('HARD_STOP');
  });

  it('returns null inside the neutral band', () => {
    expect(determineGenericExit(100, 102)).toBeNull();
    expect(determineGenericExit(100, 98)).toBeNull();
  });
});
