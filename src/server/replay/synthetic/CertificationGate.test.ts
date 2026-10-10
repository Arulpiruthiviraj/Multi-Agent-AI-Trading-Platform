// LABEL: UNIT - proves the evaluateCertification gate logic on hand-built timelines/result objects. Tests the certifier's math, not a real certified session.
import { describe, it, expect } from 'vitest';
import { evaluateCertification } from './CertificationGate';
import type { SyntheticSessionResult } from './SyntheticSessionEngine';
import type { TimelineEntry } from './DecisionTimeline';

let seq = 0;
function entry(eventType: string, opts: Partial<TimelineEntry> = {}): TimelineEntry {
  seq += 1;
  return {
    seq,
    simulatedTimeMs: 1_700_000_000_000 + seq * 1000,
    simulatedTimeIso: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    eventType,
    symbol: null,
    traceId: null,
    side: null,
    reason: null,
    summary: {},
    ...opts,
  };
}

/** Causally valid idea -> consensus -> risk -> order -> fill chain. */
function validChain(traceId: string, symbol: string, orderId: string, side: 'BUY' | 'SELL') {
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

function fakeResult(
  timeline: TimelineEntry[],
  realizedPnl = 0,
  scenarioId = 'QUIET_OPEN',
  brokerCosts: { feesPaid?: number; slippagePaid?: number } = {},
  costProfile = { commissionPerShare: 0.005, spreadBps: 2, slippageBps: 5 },
): SyntheticSessionResult {
  return {
    simulationId: 'sim_test',
    scenarioId,
    seed: 12345,
    universe: ['AAPL'],
    sessionStartMs: 1_700_000_000_000,
    sessionEndMs: 1_700_000_000_000 + 90 * 60_000,
    timeline,
    newsItems: [],
    broker: {
      snapshotCosts: () => ({
        realizedPnl,
        feesPaid: brokerCosts.feesPaid ?? 0,
        slippagePaid: brokerCosts.slippagePaid ?? 0,
      }),
    } as unknown as SyntheticSessionResult['broker'],
    memorySamples: [],
    eventLoopP50Ms: null,
    eventLoopP95Ms: null,
    eventLoopP99Ms: null,
    eventLoopMaxMs: null,
    wallClockDurationMs: 1000,
    dbPath: '/tmp/fake.db',
    calibrationSeedResults: [],
    costProfile,
  };
}

describe('evaluateCertification', () => {
  it('Test A FAILS when no market data was recorded (broken simulator, not a safety proof)', () => {
    seq = 0;
    const cert = evaluateCertification(fakeResult([]), false);
    expect(cert.certification).toBe('FAIL');
    expect(cert.reason).toContain('MARKET_DATA');
    expect(cert.stages.MARKET_DATA).toBe(false);
  });

  it('Test A passes with market data and zero trades, reporting a legible reason', () => {
    seq = 0;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      entry('TRADE_IDEA_REJECTED', { symbol: 'AAPL', traceId: 't1' }),
    ];
    const cert = evaluateCertification(fakeResult(timeline), false);
    expect(cert.certification).toBe('PASS');
    expect(cert.tradeObserved).toBe(false);
    expect(cert.zeroTradeReason).toBe('NO_SIGNAL');
    expect(cert.invariantViolations).toEqual([]);
  });

  it('Test B passes on a complete, causally valid lifecycle', () => {
    seq = 0;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      ...validChain('t1', 'AAPL', 'o1', 'BUY'),
      ...validChain('t2', 'AAPL', 'o2', 'SELL'),
    ];
    const cert = evaluateCertification(
      fakeResult(timeline, 12.5, 'VALIDATED_CONVERGENCE_CONTROL', { feesPaid: 0.2, slippagePaid: 1.1 }),
      true,
    );
    expect(cert.certification).toBe('PASS');
    expect(cert.stages.POSITION_CLOSED).toBe(true);
    expect(cert.realizedPnl).toBe(12.5);
    expect(cert.costs.feesPaid).toBe(0.2);
    expect(cert.costs.slippagePaid).toBe(1.1);
  });

  it('marks POSITION_CLOSED on a breakeven round-trip (realizedPnl === 0)', () => {
    seq = 0;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      ...validChain('t1', 'AAPL', 'o1', 'BUY'),
      ...validChain('t2', 'AAPL', 'o2', 'SELL'),
    ];
    // Breakeven close: the old `realizedPnl !== 0` inference reported POSITION_CLOSED=false.
    const cert = evaluateCertification(
      fakeResult(timeline, 0, 'VALIDATED_CONVERGENCE_CONTROL', { feesPaid: 0.2, slippagePaid: 0.9 }),
      true,
    );
    expect(cert.stages.POSITION_CLOSED).toBe(true);
    expect(cert.certification).toBe('PASS');
  });

  it('FAILs Test B on a risk bypass even when the lifecycle looks complete', () => {
    seq = 0;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      // Order submitted with NO risk assessment at all — the counting logic alone
      // would still see ORDER_SUBMITTED + ORDER_FILLED and call it a lifecycle.
      entry('ORDER_SUBMITTED', { traceId: 't1', symbol: 'AAPL', side: 'BUY', summary: { orderId: 'o1' } }),
      entry('ORDER_FILLED', { traceId: 't1', symbol: 'AAPL', side: 'BUY', summary: { orderId: 'o1' } }),
    ];
    const cert = evaluateCertification(fakeResult(timeline, 5, 'VALIDATED_CONVERGENCE_CONTROL'), true);
    expect(cert.certification).toBe('FAIL');
    expect(cert.invariantViolations.map((v) => v.code)).toContain('RISK_BYPASS');
    expect(cert.reason).toContain('RISK_BYPASS');
  });

  it('FAILs Test A on a phantom fill (safety invariants are unconditional)', () => {
    seq = 0;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      entry('ORDER_FILLED', { traceId: 't9', symbol: 'AAPL', side: 'BUY', summary: { orderId: 'ghost' } }),
    ];
    const cert = evaluateCertification(fakeResult(timeline), false);
    expect(cert.certification).toBe('FAIL');
    expect(cert.invariantViolations.map((v) => v.code)).toContain('PHANTOM_FILL');
  });

  it('FAILs on orders placed inside a feed-outage window', () => {
    seq = 0;
    const startMs = 1_700_000_000_000;
    const outageAt = startMs + 30 * 60_000;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL', simulatedTimeMs: startMs }),
      entry('RISK_ASSESSMENT_COMPLETED', { traceId: 't1', symbol: 'AAPL', summary: { approved: true }, simulatedTimeMs: outageAt - 1000 }),
      entry('ORDER_SUBMITTED', { traceId: 't1', symbol: 'AAPL', side: 'BUY', summary: { orderId: 'o1' }, simulatedTimeMs: outageAt + 60_000 }),
    ];
    const cert = evaluateCertification(fakeResult(timeline, 0, 'DATA_INTERRUPTION'), false);
    expect(cert.certification).toBe('FAIL');
    expect(cert.invariantViolations.map((v) => v.code)).toContain('ORDER_DURING_OUTAGE');
  });

  it('Test B still fails at the first blocking stage when the pipeline legitimately stops', () => {
    seq = 0;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      entry('TRADE_IDEA_GENERATED', { traceId: 't1', symbol: 'AAPL' }),
      entry('TRADE_REJECTED_CONSENSUS', { traceId: 't1', symbol: 'AAPL' }),
    ];
    const cert = evaluateCertification(fakeResult(timeline, 0, 'VALIDATED_CONVERGENCE_CONTROL'), true);
    expect(cert.certification).toBe('FAIL');
    expect(cert.firstBlockingStage).toBe('CONSENSUS');
  });

  it('FAILs when fills occur under a non-zero cost profile but zero costs were recorded', () => {
    seq = 0;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      ...validChain('t1', 'AAPL', 'o1', 'BUY'),
    ];
    // Default fake profile is non-zero (0.005/2/5) but the broker recorded no costs:
    // the cost model silently isn't biting, so simulated P&L would be gross-fiction.
    const cert = evaluateCertification(fakeResult(timeline, 5, 'VALIDATED_CONVERGENCE_CONTROL'), true);
    expect(cert.certification).toBe('FAIL');
    expect(cert.reason).toContain('cost');
  });

  it('passes with a zero-cost profile and zero recorded costs (explicit research mode)', () => {
    seq = 0;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      ...validChain('t1', 'AAPL', 'o1', 'BUY'),
    ];
    const cert = evaluateCertification(
      fakeResult(timeline, 5, 'QUIET_OPEN', {}, { commissionPerShare: 0, spreadBps: 0, slippageBps: 0 }),
      false,
    );
    expect(cert.certification).toBe('PASS');
    expect(cert.costs.feesPaid).toBe(0);
  });

  it('surfaces the session cost profile in the certification result', () => {
    seq = 0;
    const timeline = [
      entry('MARKET_DATA', { symbol: 'AAPL' }),
      ...validChain('t1', 'AAPL', 'o1', 'BUY'),
    ];
    const cert = evaluateCertification(
      fakeResult(timeline, 5, 'QUIET_OPEN', { feesPaid: 0.05, slippagePaid: 0.3 }),
      false,
    );
    expect(cert.certification).toBe('PASS');
    expect(cert.costs.costProfile).toEqual({ commissionPerShare: 0.005, spreadBps: 2, slippageBps: 5 });
  });
});
