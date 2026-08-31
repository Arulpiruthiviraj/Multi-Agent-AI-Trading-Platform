import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('whyNoTradeReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./whyNoTradeReport');
  let candidateLifecycle: typeof import('../continuous/candidateLifecycle');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_why_no_trade_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./whyNoTradeReport');
    candidateLifecycle = await import('../continuous/candidateLifecycle');
  });

  afterEach(() => {
    candidateLifecycle.resetCandidatesForTests();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seedTerminalReasonEvent(overrides: Partial<{
    id: string; ts: number; symbol: string; traceId: string; approved: boolean; decisionTier: string;
    terminalReasonCode: string; rawConfidence: number; finalConfidence: number; independentAgentCount: number;
    participatingAgents: Array<{ agent: string; side: string; confidence: number }>;
  }>) {
    const symbol = overrides.symbol ?? 'NVDA';
    const traceId = overrides.traceId ?? 'trace-nvda-1';
    const payload = {
      symbol, traceId, approved: false, decisionTier: 'STRONG', terminalReasonCode: 'CONFIDENCE_BELOW_STRONG',
      rawConfidence: 0.5, finalConfidence: 0.5, independentAgentCount: 1,
      participatingAgents: [{ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.5 }],
      ...overrides,
    };
    return db.insert(schema.observabilityEvents).values({
      id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
      ts: overrides.ts ?? Date.now(),
      level: 'INFO', category: 'CONSENSUS', eventType: 'CONSENSUS_TERMINAL_REASON',
      loggerName: 'argus', message: 'consensus_terminal_reason', sessionId: 'sess-1',
      symbol, traceId,
      payload: JSON.stringify(payload),
    });
  }

  it('reports found:false when no CONSENSUS_TERMINAL_REASON row exists for the symbol', async () => {
    const report = await mod.buildWhyNoTradeReport('GHOST');
    expect(report.found).toBe(false);
    expect(report.symbol).toBe('GHOST');
    expect(report.risk.reached).toBe(false);
  });

  it('returns the most recent evaluation for a symbol with participating agents and terminal reason', async () => {
    await seedTerminalReasonEvent({
      ts: 1000, symbol: 'NVDA', traceId: 'trace-old', terminalReasonCode: 'INSUFFICIENT_AGENT_PARTICIPATION',
    });
    await seedTerminalReasonEvent({
      ts: 2000, symbol: 'NVDA', traceId: 'trace-new', terminalReasonCode: 'CONFIDENCE_BELOW_STRONG',
      rawConfidence: 0.51, independentAgentCount: 2,
      participatingAgents: [
        { agent: 'TechnicalAgent', side: 'BUY', confidence: 0.442 },
        { agent: 'QuantEngine', side: 'BUY', confidence: 0.604 },
      ],
    });

    const report = await mod.buildWhyNoTradeReport('NVDA');
    expect(report.found).toBe(true);
    expect(report.traceId).toBe('trace-new');
    expect(report.terminalReasonCode).toBe('CONFIDENCE_BELOW_STRONG');
    expect(report.independentAgentCount).toBe(2);
    expect(report.participatingAgents).toHaveLength(2);
  });

  it('joins real risk_assessments/risk_gate_results by traceId when consensus was approved', async () => {
    await seedTerminalReasonEvent({
      symbol: 'AAPL', traceId: 'trace-approved', approved: true, decisionTier: 'STRONG',
      terminalReasonCode: 'CONSENSUS_APPROVED', rawConfidence: 0.8, finalConfidence: 0.8, independentAgentCount: 2,
    });
    await db.insert(schema.riskAssessments).values({
      traceId: 'trace-approved', symbol: 'AAPL', side: 'BUY', approved: false,
      rejectionGate: 'symbol_concentration', maxQuantity: 0, createdAt: new Date().toISOString(),
    });
    await db.insert(schema.riskGateResults).values([
      { traceId: 'trace-approved', gateName: 'emergency_stop', sequence: 1, passed: true },
      { traceId: 'trace-approved', gateName: 'symbol_concentration', sequence: 2, passed: false, detail: '{"current":0.22,"max":0.20}' },
    ]);

    const report = await mod.buildWhyNoTradeReport('AAPL');
    expect(report.approved).toBe(true);
    expect(report.risk.reached).toBe(true);
    expect(report.risk.approved).toBe(false);
    expect(report.risk.rejectionGate).toBe('symbol_concentration');
    expect(report.risk.gateResults).toHaveLength(2);
    expect(report.risk.gateResults[1]).toMatchObject({ gateName: 'symbol_concentration', passed: false });
  });

  it('includes the current candidateLifecycle state for the symbol when tracked', async () => {
    candidateLifecycle.upsertCandidate({ symbol: 'MSFT', state: 'WATCHING', now: Date.now() });
    await seedTerminalReasonEvent({ symbol: 'MSFT', traceId: 'trace-msft' });

    const report = await mod.buildWhyNoTradeReport('MSFT');
    expect(report.candidateState).toBe('WATCHING');
  });

  it('formatWhyNoTradeReport renders a readable CLI text block ending in a TRADE/NO_TRADE verdict', async () => {
    await seedTerminalReasonEvent({ symbol: 'TSLA', traceId: 'trace-tsla' });
    const report = await mod.buildWhyNoTradeReport('TSLA');
    const text = mod.formatWhyNoTradeReport(report);
    expect(text).toContain('Symbol: TSLA');
    expect(text).toContain('Final: NO_TRADE');
  });
});
