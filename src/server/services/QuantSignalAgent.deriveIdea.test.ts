import { describe, it, expect } from 'vitest';
import { deriveIdeaFromRegime, computeIntradayFetchWindow } from './QuantSignalAgent';
import { RegimeResult } from '../quant/RegimeEngine';
import { getTradingDateStr, tradingWallTimeToIso } from '../core/TradingCalendar';

function fakeRegime(overrides: Partial<RegimeResult>): RegimeResult {
  return {
    regime: 'SIDEWAYS_RANGE',
    trendStrength: 0,
    volatility: 'NORMAL',
    marketStructure: 'CHOPPY',
    confidence: 0,
    features: {} as any,
    insufficientData: false,
    ...overrides,
  };
}

describe('deriveIdeaFromRegime (Phase 3 baseline mapping)', () => {
  it('emits a real BUY idea for a confident BULLISH_TREND regime', () => {
    const idea = deriveIdeaFromRegime(fakeRegime({ regime: 'BULLISH_TREND', confidence: 0.8 }));
    expect(idea).not.toBeNull();
    expect(idea!.side).toBe('BUY');
    expect(idea!.confidence).toBe(0.8);
  });

  it('emits a real SELL idea for a confident BEARISH_TREND regime', () => {
    const idea = deriveIdeaFromRegime(fakeRegime({ regime: 'BEARISH_TREND', confidence: 0.75 }));
    expect(idea).not.toBeNull();
    expect(idea!.side).toBe('SELL');
  });

  it('emits nothing for SIDEWAYS_RANGE regardless of confidence', () => {
    expect(deriveIdeaFromRegime(fakeRegime({ regime: 'SIDEWAYS_RANGE', confidence: 0.95 }))).toBeNull();
  });

  it('emits nothing when confidence is below the minimum threshold, even for a directional regime', () => {
    expect(deriveIdeaFromRegime(fakeRegime({ regime: 'BULLISH_TREND', confidence: 0.3 }))).toBeNull();
  });

  it('emits nothing when the regime is honestly flagged insufficientData, regardless of confidence', () => {
    expect(deriveIdeaFromRegime(fakeRegime({ regime: 'BULLISH_TREND', confidence: 0.9, insufficientData: true }))).toBeNull();
  });
});

describe('computeIntradayFetchWindow (2026-09-29 intraday-bars-for-opening-range fix)', () => {
  it('mid-session: window starts at real regular-session open (09:30 ET, DST-correct) and ends at now', () => {
    // 2026-06-15 is EDT (UTC-4): 09:30 ET = 13:30 UTC. Pick "now" as 11:00 ET (15:00 UTC).
    const nowMs = Date.parse('2026-06-15T15:00:00.000Z');
    const window = computeIntradayFetchWindow(nowMs);
    expect(window).not.toBeNull();
    expect(window!.endMs).toBe(nowMs);
    const expectedOpenMs = Date.parse(tradingWallTimeToIso(getTradingDateStr(new Date(nowMs)), '09:30'));
    expect(window!.startMs).toBe(expectedOpenMs);
  });

  it('late session (>8h since open): window is capped at 8h back, never before session open but also never wider than the cap', () => {
    // Session open 09:30 ET; "now" 19:00 ET (9.5h later, past a normal session but exercises the cap).
    const nowMs = Date.parse('2026-06-15T15:00:00.000Z') + 8 * 60 * 60 * 1000; // 09:30 + 8h = 17:30 ET
    const window = computeIntradayFetchWindow(nowMs);
    expect(window).not.toBeNull();
    expect(nowMs - window!.startMs).toBeLessThanOrEqual(8 * 60 * 60 * 1000);
  });

  it('before today\'s session open (e.g. premarket): returns null - never a zero/negative-width or future-dated window', () => {
    // 08:00 ET, before the 09:30 open.
    const nowMs = Date.parse('2026-06-15T12:00:00.000Z');
    expect(computeIntradayFetchWindow(nowMs)).toBeNull();
  });

  it('is DST-correct: computes the real 09:30 ET open on both sides of a DST transition without a hardcoded offset', () => {
    // 2026-01-15 is EST (UTC-5): 09:30 ET = 14:30 UTC.
    const winterNowMs = Date.parse('2026-01-15T16:00:00.000Z'); // 11:00 ET
    const winterWindow = computeIntradayFetchWindow(winterNowMs);
    expect(winterWindow).not.toBeNull();
    expect(winterWindow!.startMs).toBe(Date.parse('2026-01-15T14:30:00.000Z'));

    // 2026-06-15 is EDT (UTC-4): 09:30 ET = 13:30 UTC.
    const summerNowMs = Date.parse('2026-06-15T15:00:00.000Z'); // 11:00 ET
    const summerWindow = computeIntradayFetchWindow(summerNowMs);
    expect(summerWindow).not.toBeNull();
    expect(summerWindow!.startMs).toBe(Date.parse('2026-06-15T13:30:00.000Z'));
  });
});
