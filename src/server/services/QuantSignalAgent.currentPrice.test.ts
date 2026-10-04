import { describe, it, expect } from 'vitest';
import { resolveQuantCurrentPrice } from './QuantSignalAgent';
import type { Bar } from '../engines/backtest/HistoricalDataGateway';

// P1-1 (2026-10-04): evaluateSymbol() used to read bars[bars.length-1].close unconditionally as
// currentPrice - for a still-forming current-day bar, that is a frozen early-session snapshot, not
// today's real price. This proves the fix's actual price-selection logic directly, without needing
// to thread the full evaluateSymbol pipeline / persisted JSON to observe the chosen price.
describe('resolveQuantCurrentPrice', () => {
  const barOpenMs = Date.UTC(2026, 9, 1, 13, 30); // 2026-10-01 09:30 ET
  const bar: Bar = { timestamp: barOpenMs, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 };

  it('prefers the live quote when the last bar is still forming (same trading day, before close)', () => {
    const duringSession = Date.UTC(2026, 9, 1, 15, 0); // 11:00 ET same day
    expect(resolveQuantCurrentPrice(bar, 105.25, duringSession)).toBe(105.25);
  });

  it('falls back to the bar close when the last bar is still forming but no live quote is available', () => {
    const duringSession = Date.UTC(2026, 9, 1, 15, 0);
    expect(resolveQuantCurrentPrice(bar, null, duringSession)).toBe(100.5);
  });

  it('falls back to the bar close when the live quote is non-finite/non-positive, even mid-session', () => {
    const duringSession = Date.UTC(2026, 9, 1, 15, 0);
    expect(resolveQuantCurrentPrice(bar, 0, duringSession)).toBe(100.5);
    expect(resolveQuantCurrentPrice(bar, -5, duringSession)).toBe(100.5);
    expect(resolveQuantCurrentPrice(bar, NaN, duringSession)).toBe(100.5);
  });

  it('uses the bar close once the bar is final, even when a live quote is available', () => {
    const afterClose = Date.UTC(2026, 9, 1, 20, 1); // 16:01 ET, same calendar day, past close
    expect(resolveQuantCurrentPrice(bar, 999, afterClose)).toBe(100.5);
    const nextDay = Date.UTC(2026, 9, 2, 13, 35);
    expect(resolveQuantCurrentPrice(bar, 999, nextDay)).toBe(100.5);
  });
});
