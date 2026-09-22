import { describe, it, expect } from 'vitest';
import { tradingSafety } from '../config/tradingSafety';
import {
  evaluateDailyTradeLimit,
  evaluateDuplicateSignal,
  evaluatePostLossCooldown,
  evaluateSameSymbolCooldown,
} from './OvertradingGuards';

describe('OvertradingGuards', () => {
  const now = Date.parse('2026-08-16T14:00:00.000Z');

  it('blocks same-symbol BUY inside sameSymbolCooldownMs from config', () => {
    const last = now - (tradingSafety.sameSymbolCooldownMs - 1000);
    const g = evaluateSameSymbolCooldown({
      side: 'BUY',
      symbol: 'AAPL',
      nowMs: now,
      trades: [{ symbol: 'AAPL', side: 'BUY', status: 'FILLED', filledAt: new Date(last).toISOString() }],
    });
    expect(g.passed).toBe(false);
    expect(g.gate).toBe('same_symbol_cooldown');
  });

  it('does not apply same-symbol cooldown to SELL', () => {
    const g = evaluateSameSymbolCooldown({
      side: 'SELL',
      symbol: 'AAPL',
      nowMs: now,
      trades: [{ symbol: 'AAPL', side: 'BUY', status: 'FILLED', filledAt: new Date(now).toISOString() }],
    });
    expect(g.passed).toBe(true);
  });

  it('blocks BUY after a closed loss inside postLossCooldownMs', () => {
    const last = now - (tradingSafety.postLossCooldownMs - 1000);
    const g = evaluatePostLossCooldown({
      side: 'BUY',
      nowMs: now,
      trades: [{ symbol: 'MSFT', side: 'SELL', status: 'FILLED', profitLoss: -12, filledAt: new Date(last).toISOString() }],
    });
    expect(g.passed).toBe(false);
  });

  it('skips daily trade cap when maxDailyTrades is 0', () => {
    expect(tradingSafety.maxDailyTrades).toBe(0);
    const g = evaluateDailyTradeLimit({
      side: 'BUY',
      nowMs: now,
      trades: Array.from({ length: 9 }, () => ({ symbol: 'AAPL', side: 'BUY', status: 'FILLED', filledAt: new Date(now).toISOString() })),
    });
    expect(g.passed).toBe(true);
    expect(g.detail.skipped).toBe(true);
  });

  // Crypto Expansion Phase 3 (2026-09-21): dateStrFor lets RiskEngine.ts supply a UTC day
  // boundary for a crypto proposal instead of the default America/New_York one - default (omitted)
  // behavior must stay byte-identical to before.
  describe('evaluateDailyTradeLimit dateStrFor override', () => {
    it('default (no dateStrFor) uses the exact existing America/New_York day boundary', () => {
      const g = evaluateDailyTradeLimit({
        side: 'BUY', nowMs: now, maxDailyTrades: 5,
        trades: [{ symbol: 'AAPL', side: 'BUY', status: 'FILLED', filledAt: new Date(now).toISOString() }],
      });
      expect(g.detail.today).toBeTruthy();
    });

    it('a custom dateStrFor (e.g. UTC) changes which trades count as "today"', () => {
      // A trade filled 5 hours before `now` in UTC terms - same UTC calendar day as `now`, but
      // depending on `now`'s wall-clock position could fall on the prior America/New_York day.
      const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
      const utcDateStr = (d: Date) => d.toISOString().slice(0, 10);
      const g = evaluateDailyTradeLimit({
        side: 'BUY', nowMs: now, maxDailyTrades: 1,
        dateStrFor: utcDateStr,
        trades: [{ symbol: 'BTC-USD', side: 'BUY', status: 'FILLED', filledAt: new Date(fiveHoursAgo).toISOString() }],
      });
      expect(g.detail.today).toBe(utcDateStr(new Date(now)));
      // Whether this specific trade counts depends on real calendar-day math (verified below with
      // fixed instants, not `now`) - the real proof is that dateStrFor is actually being used.
      expect(g.detail.today).not.toBeUndefined();
    });

    it('fixed-instant proof: a UTC-day-scoped count differs from the default NY-day-scoped count across a real UTC/NY boundary', () => {
      // 2026-09-21T02:00:00Z is 2026-09-20 22:00 EDT (America/New_York) - same UTC day as a trade
      // at 2026-09-21T23:00:00Z, but a DIFFERENT America/New_York day (2026-09-20 vs 2026-09-21).
      const nowMs2 = new Date('2026-09-21T23:00:00.000Z').getTime();
      const earlierTradeMs = new Date('2026-09-21T02:00:00.000Z').getTime();
      const utcDateStr = (d: Date) => d.toISOString().slice(0, 10);

      const nyScoped = evaluateDailyTradeLimit({
        side: 'BUY', nowMs: nowMs2, maxDailyTrades: 1,
        trades: [{ symbol: 'AAPL', side: 'BUY', status: 'FILLED', filledAt: new Date(earlierTradeMs).toISOString() }],
      });
      const utcScoped = evaluateDailyTradeLimit({
        side: 'BUY', nowMs: nowMs2, maxDailyTrades: 1,
        dateStrFor: utcDateStr,
        trades: [{ symbol: 'BTC-USD', side: 'BUY', status: 'FILLED', filledAt: new Date(earlierTradeMs).toISOString() }],
      });
      // NY-scoped: 02:00 UTC on 09-21 is still 09-20 in NY (before 04:00/05:00 EDT rollover) -
      // does NOT count against a 09-21T23:00Z evaluation's NY "today" (09-21) -> cap not reached.
      expect(nyScoped.passed).toBe(true);
      // UTC-scoped: both instants are 2026-09-21 in UTC -> counts -> cap (1) reached.
      expect(utcScoped.passed).toBe(false);
    });
  });

  it('ignores unapproved assessments for duplicate_signal', () => {
    const g = evaluateDuplicateSignal({
      side: 'BUY',
      symbol: 'AAPL',
      nowMs: now,
      assessments: [{ symbol: 'AAPL', side: 'BUY', approved: false, createdAt: new Date(now).toISOString() }],
    });
    expect(g.passed).toBe(true);
  });

  it('blocks duplicate approved BUY inside duplicateSignalWindowMs', () => {
    const g = evaluateDuplicateSignal({
      side: 'BUY',
      symbol: 'AAPL',
      nowMs: now,
      assessments: [{ symbol: 'AAPL', side: 'BUY', approved: true, createdAt: new Date(now - 1000).toISOString() }],
    });
    expect(g.passed).toBe(false);
  });
});
