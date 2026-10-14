import { describe, expect, it } from 'vitest';
import { runLineageOracle, type LineageRows } from './lineageOracle';

const empty = (): LineageRows => ({ ideas: [], evidenceSourceTraceIds: [], rejectionTraceIds: [], risk: [], trades: [], fills: [], openPositions: [] });

describe('lineageOracle', () => {
  it('classifies every idea fate and flags an idea that vanished', () => {
    const r = runLineageOracle({
      ...empty(),
      ideas: [
        { traceId: 'a', agent: 'T', symbol: 'X', atMs: 1 }, // evidence
        { traceId: 'b', agent: 'T', symbol: 'Y', atMs: 1 }, // rejected
        { traceId: 'c', agent: 'T', symbol: 'Z', atMs: 1 }, // superseded by d
        { traceId: 'd', agent: 'T', symbol: 'Z', atMs: 5 }, // vanished
        { traceId: 'e', agent: 'K', symbol: 'W', atMs: 100_000 }, // pending at end
      ],
      evidenceSourceTraceIds: ['a'], rejectionTraceIds: ['b'], endMs: 120_000, pendingWindowMs: 60_000,
    });
    expect(r.fates).toMatchObject({ CONSENSUS_EVIDENCE: 1, EXPLICIT_REJECTION: 1, SUPERSEDED: 1, PENDING_AT_END: 1, UNTERMINATED: 1 });
    expect(r.unterminated).toEqual(['d']);
  });

  it('allows a partial fill followed by a cancel of the remainder, but not fills on a cancel that left nothing unfilled, nor overfills', () => {
    const base = empty();
    const trade = (status: string, qty = 10) => ({ id: 'o', traceId: null, transactionId: null, side: 'SELL' as const, status, symbol: 'A', quantity: qty });
    const ok = runLineageOracle({ ...base, trades: [trade('CANCELED')], fills: [{ orderId: 'o', quantity: 4 }], openPositions: [{ symbol: 'A', quantity: -4 }] });
    expect(ok.violations.filter((v) => v.code !== 'POSITION_NOT_EXPLAINED_BY_FILLS')).toEqual([]);
    const bad = runLineageOracle({ ...base, trades: [trade('CANCELED')], fills: [{ orderId: 'o', quantity: 10 }], openPositions: [{ symbol: 'A', quantity: -10 }] });
    expect(bad.violations.map((v) => v.code)).toContain('FILL_ON_NON_FILLED_ORDER');
    const over = runLineageOracle({ ...base, trades: [trade('FILLED')], fills: [{ orderId: 'o', quantity: 11 }], openPositions: [{ symbol: 'A', quantity: -11 }] });
    expect(over.violations.map((v) => v.code)).toContain('OVERFILLED_ORDER');
  });

  it('requires risk approval before a BUY, a fill for a FILLED order, and fills that explain the portfolio', () => {
    const base = empty();
    const bad = runLineageOracle({
      ...base,
      trades: [{ id: 'o1', traceId: 't1', transactionId: 'x1', side: 'BUY', status: 'FILLED', symbol: 'A', quantity: 10 }],
      risk: [{ traceId: 't1', approved: false, transactionId: 'x1' }],
      openPositions: [{ symbol: 'A', quantity: 10 }],
    });
    expect(bad.violations.map((v) => v.code).sort()).toEqual(['BUY_AFTER_RISK_REJECTION', 'FILLED_ORDER_WITHOUT_FILL', 'POSITION_NOT_EXPLAINED_BY_FILLS']);
    const good = runLineageOracle({
      ...base,
      trades: [
        { id: 'o1', traceId: 't1', transactionId: 'x1', side: 'BUY', status: 'FILLED', symbol: 'A', quantity: 10 },
        { id: 'o2', traceId: 't2', transactionId: null, side: 'SELL', status: 'FILLED', symbol: 'A', quantity: 4 },
      ],
      risk: [{ traceId: 't1', approved: true, transactionId: 'x1' }],
      fills: [{ orderId: 'o1', quantity: 10 }, { orderId: 'o2', quantity: 4 }],
      openPositions: [{ symbol: 'A', quantity: 6 }],
    });
    expect(good.violations).toEqual([]);
  });
});
