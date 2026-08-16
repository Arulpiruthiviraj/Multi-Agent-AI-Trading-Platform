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
