import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('consensusPipelineReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./consensusPipelineReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_consensus_report_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./consensusPipelineReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seedTerminalReasonEvent(overrides: Partial<{
    id: string; ts: number; symbol: string; approved: boolean; decisionTier: string;
    terminalReasonCode: string; rawConfidence: number; independentAgentCount: number;
    participatingAgents: Array<{ agent: string; side: string; confidence: number }>;
  }>) {
    const payload = {
      symbol: 'AAPL', approved: false, decisionTier: 'STRONG', terminalReasonCode: 'CONFIDENCE_BELOW_STRONG',
      rawConfidence: 0.5, independentAgentCount: 1, participatingAgents: [{ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.5 }],
      ...overrides,
    };
    return db.insert(schema.observabilityEvents).values({
      id: overrides.id ?? `evt-${Math.random().toString(36).slice(2)}`,
      ts: overrides.ts ?? Date.now(),
      level: 'INFO', category: 'CONSENSUS', eventType: 'CONSENSUS_TERMINAL_REASON',
      loggerName: 'argus', message: 'consensus_terminal_reason', sessionId: 'sess-1',
      payload: JSON.stringify(payload),
    });
  }

  it('returns an all-zero report when no CONSENSUS_TERMINAL_REASON rows exist in the window', async () => {
    const report = await mod.buildConsensusPipelineReport(new Date('2026-08-27T00:00:00.000Z').toISOString());
    expect(report.evaluations).toBe(0);
    expect(report.topTerminalReasons).toEqual([]);
    expect(report.riskEngineReached).toBe(0);
    expect(report.ordersPlaced).toBe(0);
    expect(report.fillsRecorded).toBe(0);
  });

  it('classifies approved rounds into moderateEligibleCount/strongApprovedCount by decisionTier, and counts confidence buckets', async () => {
    const base = new Date('2026-08-27T18:00:00.000Z').getTime();
    await seedTerminalReasonEvent({ ts: base, approved: true, decisionTier: 'STRONG', rawConfidence: 0.9, terminalReasonCode: 'CONSENSUS_APPROVED' });
    await seedTerminalReasonEvent({ ts: base + 1000, approved: true, decisionTier: 'MODERATE', rawConfidence: 0.65, terminalReasonCode: 'CONSENSUS_APPROVED' });
    await seedTerminalReasonEvent({ ts: base + 2000, approved: false, rawConfidence: 0.4, terminalReasonCode: 'CONFIDENCE_BELOW_STRONG' });

    const report = await mod.buildConsensusPipelineReport(new Date('2026-08-27T17:00:00.000Z').toISOString());
    expect(report.evaluations).toBe(3);
    expect(report.approvedCount).toBe(2);
    expect(report.strongApprovedCount).toBe(1);
    expect(report.moderateEligibleCount).toBe(1);
    expect(report.confidenceAtLeast60).toBe(2);
    expect(report.confidenceAtLeast75).toBe(1);
    // All three seeded rows carry the default participatingAgents: [{agent: 'TechnicalAgent', side: 'BUY'}]
    expect(report.directionalVotesByAgent.TechnicalAgent).toBe(3);
  });

  it('buckets independent-agent-count and ranks top terminal reasons by frequency', async () => {
    const base = new Date('2026-08-27T19:00:00.000Z').getTime();
    await seedTerminalReasonEvent({ ts: base, independentAgentCount: 0, terminalReasonCode: 'AGENT_HOLD' });
    await seedTerminalReasonEvent({ ts: base + 1000, independentAgentCount: 1, terminalReasonCode: 'INSUFFICIENT_AGENT_PARTICIPATION' });
    await seedTerminalReasonEvent({ ts: base + 2000, independentAgentCount: 1, terminalReasonCode: 'INSUFFICIENT_AGENT_PARTICIPATION' });
    await seedTerminalReasonEvent({ ts: base + 3000, independentAgentCount: 5, terminalReasonCode: 'HARD_VETO' });

    const report = await mod.buildConsensusPipelineReport(new Date('2026-08-27T18:30:00.000Z').toISOString());
    expect(report.independentAgreementCounts['0']).toBe(1);
    expect(report.independentAgreementCounts['1']).toBe(2);
    expect(report.independentAgreementCounts['4+']).toBe(1);
    expect(report.topTerminalReasons[0]).toEqual({ code: 'INSUFFICIENT_AGENT_PARTICIPATION', count: 2 });
  });

  it('joins real risk_assessments/trades/fills counts within the window', async () => {
    const sinceIso = '2026-08-27T00:00:00.000Z';
    await db.insert(schema.riskAssessments).values({
      traceId: 'trace-1', symbol: 'AAPL', side: 'BUY', approved: true, maxQuantity: 10,
      createdAt: '2026-08-27T12:00:00.000Z',
    });
    await db.insert(schema.riskAssessments).values({
      traceId: 'trace-2', symbol: 'MSFT', side: 'BUY', approved: false, rejectionGate: 'data_freshness', maxQuantity: 0,
      createdAt: '2026-08-27T12:05:00.000Z',
    });
    await db.insert(schema.trades).values({
      id: 'trade-1', symbol: 'AAPL', side: 'BUY', quantity: 10, price: 100, status: 'FILLED',
      timestamp: '2026-08-27T12:00:10.000Z', submittedAt: '2026-08-27T12:00:10.000Z',
    });
    await db.insert(schema.fills).values({
      orderId: 'trade-1', quantity: 10, price: 100, filledAt: '2026-08-27T12:00:20.000Z', cumulativeQuantity: 10,
    });

    const report = await mod.buildConsensusPipelineReport(sinceIso);
    expect(report.riskEngineReached).toBe(2);
    expect(report.riskApproved).toBe(1);
    expect(report.ordersPlaced).toBe(1);
    expect(report.fillsRecorded).toBe(1);
  });

  it('formatConsensusPipelineReport renders a readable CLI text block', async () => {
    const report = await mod.buildConsensusPipelineReport(new Date('2026-08-27T00:00:00.000Z').toISOString());
    const text = mod.formatConsensusPipelineReport(report);
    expect(text).toContain('CONSENSUS PIPELINE');
    expect(text).toContain('TOP NO-TRADE REASONS');
  });
});
