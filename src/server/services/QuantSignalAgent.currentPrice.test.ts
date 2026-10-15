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

  it("uses the bar's official close after that same session ends (today's own post-close bar)", () => {
    const afterClose = Date.UTC(2026, 9, 1, 20, 1); // 16:01 ET, same calendar day, past close
    expect(resolveQuantCurrentPrice(bar, 999, afterClose)).toBe(100.5);
  });

  // 2026-10-15 regression (MRNA/MCD forensics): this case used to assert the OPPOSITE (bar close wins) - i.e. it encoded the defect. A final bar from an EARLIER session is stale.
  it('prefers a valid live quote over a final bar from an EARLIER session (stale-bar defect: MRNA 216.25 vs live 238.3)', () => {
    const nextDay = Date.UTC(2026, 9, 2, 13, 35); // the bar is Oct 1; it is now Oct 2 09:35 ET
    expect(resolveQuantCurrentPrice(bar, 999, nextDay)).toBe(999);
    const twoSessionsLater = Date.UTC(2026, 9, 5, 14, 0); // Oct 5 10:00 ET (Oct 2 and the intervening bars missing)
    expect(resolveQuantCurrentPrice(bar, 238.3, twoSessionsLater)).toBe(238.3);
  });

  it('still falls back to the stale bar close when no valid live quote exists (never silently dropping the evaluation)', () => {
    const nextDay = Date.UTC(2026, 9, 2, 13, 35);
    expect(resolveQuantCurrentPrice(bar, null, nextDay)).toBe(100.5);
    expect(resolveQuantCurrentPrice(bar, 0, nextDay)).toBe(100.5);
    expect(resolveQuantCurrentPrice(bar, NaN, nextDay)).toBe(100.5);
  });
});
