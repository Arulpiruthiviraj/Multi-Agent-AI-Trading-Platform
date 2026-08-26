import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Real test coverage for the pre-market/market-open operator observability report (2026-08-24
 * readiness audit, Part 10). A generic from/where/limit-chaining mock (same shape drizzle's own
 * query builder resolves to) lets each table return whatever rows the test registers, without
 * needing a real SQLite connection.
 */
const { mockDb, setTableRows, resetTableRows } = vi.hoisted(() => {
  const resultsByTable = new Map<any, any[]>();
  let lastTable: any = null;
  const builder: any = {
    from(table: any) { lastTable = table; return builder; },
    where() { return builder; },
    limit() { return builder; },
    orderBy() { return builder; },
    then(resolve: any, reject: any) {
      return Promise.resolve(resultsByTable.get(lastTable) || []).then(resolve, reject);
    },
  };
  return {
    mockDb: { select: () => builder },
    setTableRows: (table: any, rows: any[]) => resultsByTable.set(table, rows),
    resetTableRows: () => resultsByTable.clear(),
  };
});

const { health } = vi.hoisted(() => ({ health: vi.fn() }));
const { getAIProviderHealthSnapshot } = vi.hoisted(() => ({ getAIProviderHealthSnapshot: vi.fn() }));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('./ArgusRuntime', () => ({ argusRuntime: { health } }));
vi.mock('../ai/AIProviderHealthCheck', () => ({ getAIProviderHealthSnapshot }));

import * as schema from '../db/schema';
import { getTradingSessionReport, renderTradingSessionReport, type TradingSessionReport } from './tradingSessionReport';

describe('tradingSessionReport', () => {
  beforeEach(() => {
    resetTableRows();
    setTableRows(schema.eventTraces, []);
    setTableRows(schema.trades, []);
    setTableRows(schema.riskAssessments, []);
    setTableRows(schema.aiCalls, []);
    health.mockReturnValue({ ok: true, marketDataConnected: true, liveReadiness: 'LIVE_NO_GO', emergencyStopActive: false });
    getAIProviderHealthSnapshot.mockResolvedValue([
      { providerId: 'p1', status: 'HEALTHY' },
      { providerId: 'p2', status: 'AUTH_FAILED' },
    ]);
  });

  it('reports zero counts (not an error) when nothing has happened today', async () => {
    const report = await getTradingSessionReport();
    expect(report.decisionPipeline.ideasGenerated).toBe(0);
    expect(report.execution.fills).toBe(0);
    expect(report.ai.healthyProviders).toBe(1);
    expect(report.ai.degradedProviders).toBe(1);
  });

  it('reports the real broker-aware streaming cap when the route passes maxSymbols, instead of always showing the hardcoded 90 (2026-08-25 fix)', async () => {
    // Confirmed live: with Alpaca active (real cap 12 via continuousIntelligence.maxActiveSubscriptions),
    // the report previously always showed "/ 90" regardless of the active broker, implying free
    // capacity that did not exist - 44 real MARKET_DATA_CAPACITY_FULL events the same session were
    // the direct evidence this was misleading, not just cosmetically wrong.
    const report = await getTradingSessionReport({ activeSymbols: 12, maxSymbols: 12 });
    expect(report.market.activeSymbols).toBe(12);
    expect(report.market.maxSymbols).toBe(12);
  });

  it('still defaults maxSymbols to 90 when the route does not pass an override (back-compat)', async () => {
    const report = await getTradingSessionReport({ activeSymbols: 5 });
    expect(report.market.maxSymbols).toBe(90);
  });

  it('counts real event_traces rows by type', async () => {
    const now = Date.now();
    setTableRows(schema.eventTraces, [
      { eventType: 'TRADE_IDEA_GENERATED', timestamp: now, payload: null },
      { eventType: 'TRADE_IDEA_GENERATED', timestamp: now, payload: null },
      { eventType: 'TRADE_IDEA_REJECTED', timestamp: now, payload: '{"reason":"MISSING_PRICE"}' },
      { eventType: 'CHIEF_APPROVED_IDEA', timestamp: now, payload: null },
    ]);
    const report = await getTradingSessionReport();
    expect(report.decisionPipeline.ideasGenerated).toBe(2);
    expect(report.decisionPipeline.ideasRejected).toBe(1);
    expect(report.decisionPipeline.missingPrice).toBe(1);
    expect(report.decisionPipeline.chiefTraderApproved).toBe(1);
  });

  it('never counts a REPLAY-tagged trade as organic execution - the whole point of the executionContextBreakdown separation', async () => {
    const todayIso = new Date().toISOString();
    setTableRows(schema.trades, [
      { timestamp: todayIso, executionEnvironment: 'PAPER', status: 'FILLED', traceId: 't-1', reasoning: '' },
      { timestamp: todayIso, executionEnvironment: 'REPLAY', status: 'FILLED', traceId: 'replay-abc', reasoning: '' },
    ]);
    const report = await getTradingSessionReport();
    expect(report.execution.fills).toBe(1); // only the real PAPER fill
    expect(report.executionContextBreakdown.REPLAY.trades).toBe(1);
    expect(report.executionContextBreakdown.PAPER.trades).toBe(1);
  });

  it('render never mixes organic and replay/backtest/simulation counts in the same section', () => {
    const report: TradingSessionReport = {
      generatedAt: new Date().toISOString(),
      tradingDate: '2026-08-24',
      market: { session: 'RTH', marketDataReady: true, activeSymbols: 18, maxSymbols: 90, candidateSymbolsMissingPrice: 3 },
      decisionPipeline: { ideasGenerated: 10, ideasRejected: 3, missingPrice: 3, consensusRoundsStarted: 5, chiefTraderApproved: 0, consensusRejected: 5 },
      execution: { riskEvaluations: 0, riskApproved: 0, ordersSubmitted: 0, ordersAccepted: 0, fills: 0, reconciliationMatches: 2 },
      ai: { healthyProviders: 5, degradedProviders: 5, totalProviders: 10, callSuccessRatePct: 42.5, consensusProvidersAvailable: true },
      safety: { paperTradingOnly: true, liveReadiness: 'LIVE_NO_GO', killSwitchActive: false, interruptedSessionHold: false },
      executionContextBreakdown: {
        LIVE: { trades: 0, riskAssessments: 0 },
        PAPER: { trades: 0, riskAssessments: 0 },
        REPLAY: { trades: 24, riskAssessments: 24 },
        BACKTEST: { trades: 0, riskAssessments: 0 },
        SIMULATION: { trades: 0, riskAssessments: 0 },
        UNKNOWN: { trades: 0, riskAssessments: 0 },
      },
    };
    const text = renderTradingSessionReport(report);
    expect(text).toContain('Execution (organic PAPER/LIVE only');
    expect(text).toContain('REPLAY: 24 trades, 24 risk assessments');
    // The organic Execution section's own fills/riskEvaluations line must not silently absorb the 24 replay rows.
    expect(text).toContain('Fills: 0');
    expect(text).toContain('Risk Evaluations: 0');
  });
});
