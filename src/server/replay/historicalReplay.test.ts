import { describe, it, expect } from 'vitest';
import { aiHistoricalReplayAvailability } from './aiReplayAvailability';
import { buildReplayLedger, overconfidenceFlags } from './buildReplayLedger';
import { ReplayClock } from '../engines/backtest/ReplayClock';

describe('aiHistoricalReplayAvailability', () => {
  it('refuses historical AI replay with WHAT/WHY/IMPACT/FIX instead of a fake 2022 LLM path', () => {
    const status = aiHistoricalReplayAvailability();
    expect(status.available).toBe(false);
    expect(status.status).toBe('UNAVAILABLE');
    expect(status.why).toMatch(/point-in-time/i);
    expect(status.fix.length).toBeGreaterThan(20);
    expect(status.lookaheadRisk).toMatch(/ReplayClock|weights|future/i);
  });
});

describe('buildReplayLedger', () => {
  it('pairs BUY then SELL into prediction-vs-actual rows', () => {
    const ledger = buildReplayLedger([
      { side: 'BUY', timestamp: Date.parse('2022-04-11T10:32:00Z'), price: 100, quantity: 4, symbol: 'AMD' },
      { side: 'SELL', timestamp: Date.parse('2022-04-12T10:32:00Z'), price: 106, quantity: 4, symbol: 'AMD', realizedPnl: 24, rMultiple: 1.2 },
    ], 'AMD');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].result).toBe('WIN');
    expect(ledger[0].predictionCorrect).toBe(true);
    expect(ledger[0].predictedSide).toBe('BUY');
    expect(ledger[0].actualDirection).toBe('UP');
    expect(ledger[0].pnlPct).toBeCloseTo(6, 5);
  });

  it('marks a losing round-trip as INCORRECT without inventing AI votes', () => {
    const ledger = buildReplayLedger([
      { side: 'BUY', timestamp: 1, price: 100, quantity: 1 },
      { side: 'SELL', timestamp: 2, price: 90, quantity: 1, realizedPnl: -10, rMultiple: -1, failureCategory: 'STOP_LOSS_HIT' },
    ]);
    expect(ledger[0].result).toBe('LOSS');
    expect(ledger[0].predictionCorrect).toBe(false);
    expect(ledger[0].failureCategory).toBe('STOP_LOSS_HIT');
    const flags = overconfidenceFlags(ledger);
    expect(flags.highRLosses).toBe(1);
    expect(flags.aiConfidenceLosses).toBe('UNAVAILABLE');
  });
});

describe('ReplayClock look-ahead guard (reused, not reimplemented)', () => {
  it('throws LOOK_AHEAD_BIAS_DETECTED when a future timestamp is asserted', () => {
    const clock = new ReplayClock(Date.parse('2022-01-01T00:00:00Z'));
    expect(() => clock.assertNotFuture(Date.parse('2022-01-02T00:00:00Z'), 'news')).toThrow(/LOOK_AHEAD_BIAS_DETECTED/);
  });
});
