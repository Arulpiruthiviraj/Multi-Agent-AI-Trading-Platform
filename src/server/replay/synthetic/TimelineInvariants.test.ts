// LABEL: UNIT - proves the checkTimelineInvariants pure-logic assertions on hand-built timelines. Does NOT exercise a real session.
import { describe, it, expect } from 'vitest';
import {
  checkTimelineInvariants,
  outageWindowsForScenario,
} from './TimelineInvariants';
import type { TimelineEntry } from './DecisionTimeline';

let seq = 0;
function entry(
  eventType: string,
  opts: Partial<TimelineEntry> = {},
): TimelineEntry {
  seq += 1;
  return {
    seq,
    simulatedTimeMs: 1_000_000 + seq * 1000,
    simulatedTimeIso: new Date(1_000_000 + seq * 1000).toISOString(),
    eventType,
    symbol: null,
    traceId: null,
    side: null,
    reason: null,
    summary: {},
    ...opts,
  };
}

function reset() {
  seq = 0;
}

/** A causally valid idea -> consensus -> risk -> order -> fill chain. */
function validChain(traceId: string, symbol = 'AAPL', orderId = 'o1', side: 'BUY' | 'SELL' = 'BUY') {
  return [
    entry('TRADE_IDEA_GENERATED', { traceId, symbol }),
    entry('CHIEF_CONSENSUS_STARTED', { traceId, symbol }),
    entry('CHIEF_CONSENSUS_COMPLETED', { traceId, symbol }),
    entry('CHIEF_APPROVED_IDEA', { traceId, symbol }),
    entry('RISK_ASSESSMENT_COMPLETED', { traceId, symbol, summary: { approved: true } }),
    entry('ORDER_SUBMITTED', { traceId, symbol, side, summary: { orderId } }),
    entry('ORDER_FILLED', { traceId, symbol, side, summary: { orderId } }),
  ];
}

describe('checkTimelineInvariants', () => {
  it('reports no violations for a causally valid chain', () => {
    reset();
    const timeline = [entry('MARKET_DATA'), ...validChain('t1')];
    expect(checkTimelineInvariants(timeline)).toEqual([]);
  });

  it('flags RISK_BYPASS when an order has no prior risk approval', () => {
    reset();
    const timeline = [
      entry('MARKET_DATA'),
      entry('TRADE_IDEA_GENERATED', { traceId: 't1', symbol: 'AAPL' }),
      entry('ORDER_SUBMITTED', { traceId: 't1', symbol: 'AAPL', side: 'BUY', summary: { orderId: 'o9' } }),
    ];
    const v = checkTimelineInvariants(timeline);
    expect(v.map((x) => x.code)).toContain('RISK_BYPASS');
    expect(v.find((x) => x.code === 'RISK_BYPASS')!.severity).toBe('FAIL');
  });

  it('flags RISK_BYPASS when the risk assessment rejected', () => {
    reset();
    const timeline = [
      entry('MARKET_DATA'),
      entry('RISK_ASSESSMENT_COMPLETED', { traceId: 't1', symbol: 'AAPL', summary: { approved: false } }),
      entry('ORDER_SUBMITTED', { traceId: 't1', symbol: 'AAPL', side: 'BUY', summary: { orderId: 'o9' } }),
    ];
    expect(checkTimelineInvariants(timeline).map((x) => x.code)).toContain('RISK_BYPASS');
  });

  it('does not confuse risk approvals across traceIds', () => {
    reset();
    const timeline = [
      entry('MARKET_DATA'),
      entry('RISK_ASSESSMENT_COMPLETED', { traceId: 'other', symbol: 'AAPL', summary: { approved: true } }),
      entry('ORDER_SUBMITTED', { traceId: 't1', symbol: 'AAPL', side: 'BUY', summary: { orderId: 'o9' } }),
    ];
    expect(checkTimelineInvariants(timeline).map((x) => x.code)).toContain('RISK_BYPASS');
  });

  it('flags PHANTOM_FILL when a fill has no preceding order', () => {
    reset();
    const timeline = [
      entry('MARKET_DATA'),
      entry('ORDER_FILLED', { traceId: 't1', symbol: 'AAPL', side: 'BUY', summary: { orderId: 'ghost' } }),
    ];
    const v = checkTimelineInvariants(timeline);
    expect(v.map((x) => x.code)).toContain('PHANTOM_FILL');
    expect(v.find((x) => x.code === 'PHANTOM_FILL')!.severity).toBe('FAIL');
  });

  it('links fills to orders by traceId when orderId is absent', () => {
    reset();
    const timeline = [
      entry('MARKET_DATA'),
      entry('RISK_ASSESSMENT_COMPLETED', { traceId: 't1', symbol: 'AAPL', summary: { approved: true } }),
      entry('ORDER_SUBMITTED', { traceId: 't1', symbol: 'AAPL', side: 'BUY' }),
      entry('ORDER_FILLED', { traceId: 't1', symbol: 'AAPL', side: 'BUY' }),
    ];
    expect(checkTimelineInvariants(timeline).map((x) => x.code)).not.toContain('PHANTOM_FILL');
  });

  it('flags CONSENSUS_BYPASS when chief approves without a debate', () => {
    reset();
    const timeline = [
      entry('MARKET_DATA'),
      entry('TRADE_IDEA_GENERATED', { traceId: 't1', symbol: 'AAPL' }),
      entry('CHIEF_APPROVED_IDEA', { traceId: 't1', symbol: 'AAPL' }),
    ];
    expect(checkTimelineInvariants(timeline).map((x) => x.code)).toContain('CONSENSUS_BYPASS');
  });

  it('flags ORDER_DURING_OUTAGE for orders inside a feed-outage window', () => {
    reset();
    const outageStart = 2_000_000;
    const timeline = [
      entry('MARKET_DATA', { simulatedTimeMs: outageStart - 60_000 }),
      entry('RISK_ASSESSMENT_COMPLETED', { traceId: 't1', symbol: 'AAPL', summary: { approved: true }, simulatedTimeMs: outageStart - 30_000 }),
      entry('ORDER_SUBMITTED', { traceId: 't1', symbol: 'AAPL', side: 'BUY', summary: { orderId: 'o1' }, simulatedTimeMs: outageStart + 60_000 }),
    ];
    const v = checkTimelineInvariants(timeline, {
      outageWindows: [{ fromMs: outageStart, toMs: outageStart + 600_000, label: 'test outage' }],
    });
    expect(v.map((x) => x.code)).toContain('ORDER_DURING_OUTAGE');
  });

  it('warns (not fails) on orders with no traceId when an approval exists', () => {
    reset();
    const timeline = [
      entry('MARKET_DATA'),
      entry('RISK_ASSESSMENT_COMPLETED', { traceId: 't1', symbol: 'AAPL', summary: { approved: true } }),
      entry('ORDER_SUBMITTED', { traceId: null, symbol: 'AAPL', side: 'BUY', summary: { orderId: 'o1' } }),
    ];
    const v = checkTimelineInvariants(timeline);
    expect(v.map((x) => x.code)).not.toContain('RISK_BYPASS');
    const w = v.find((x) => x.code === 'UNLINKED_ORDER');
    expect(w?.severity).toBe('WARN');
  });
});

describe('outageWindowsForScenario', () => {
  it('derives the DATA_INTERRUPTION window from the scenario definition', () => {
    const startMs = 1_700_000_000_000;
    const windows = outageWindowsForScenario('DATA_INTERRUPTION', startMs);
    expect(windows).toHaveLength(1);
    // Scenario: outage at +30min for 10 bars.
    expect(windows[0].fromMs).toBe(startMs + 30 * 60_000);
    expect(windows[0].toMs).toBe(startMs + 40 * 60_000);
  });

  it('returns no windows for scenarios without interruptions', () => {
    expect(outageWindowsForScenario('QUIET_OPEN', 1_700_000_000_000)).toEqual([]);
  });

  it('returns no windows for unknown scenario ids', () => {
    expect(outageWindowsForScenario('NOPE', 1_700_000_000_000)).toEqual([]);
  });
});
