import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('tradingFunnelReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./tradingFunnelReport');
  let candidateLifecycle: typeof import('../continuous/candidateLifecycle');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_trading_funnel_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./tradingFunnelReport');
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

  it('composes real candidateLifecycle counts + an empty consensus/provider report with no data', async () => {
    candidateLifecycle.upsertCandidate({ symbol: 'AAPL', state: 'DISCOVERED', now: Date.now() });
    candidateLifecycle.upsertCandidate({ symbol: 'MSFT', state: 'WATCHING', now: Date.now() });
    candidateLifecycle.upsertCandidate({ symbol: 'OLD', state: 'STALE', now: Date.now() });

    const report = await mod.buildTradingFunnelReport(new Date('2026-08-27T00:00:00.000Z').toISOString());
    expect(report.candidatesByState).toEqual({ DISCOVERED: 1, WATCHING: 1, STALE: 1 });
    expect(report.consensus.evaluations).toBe(0);
    expect(report.providers).toEqual([]);
  });

  it('reflects a real CONSENSUS_TERMINAL_REASON row in the composed consensus section', async () => {
    await db.insert(schema.observabilityEvents).values({
      id: 'evt-1', ts: new Date('2026-08-27T18:00:00.000Z').getTime(), level: 'INFO', category: 'CONSENSUS',
      eventType: 'CONSENSUS_TERMINAL_REASON', loggerName: 'argus', message: 'consensus_terminal_reason',
      sessionId: 'sess-1', symbol: 'NVDA',
      payload: JSON.stringify({
        symbol: 'NVDA', approved: true, decisionTier: 'STRONG', terminalReasonCode: 'CONSENSUS_APPROVED',
        rawConfidence: 0.9, independentAgentCount: 2,
        participatingAgents: [{ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.9 }],
      }),
    });

    const report = await mod.buildTradingFunnelReport(new Date('2026-08-27T17:00:00.000Z').toISOString());
    expect(report.consensus.evaluations).toBe(1);
    expect(report.consensus.strongApprovedCount).toBe(1);
  });

  it('formatTradingFunnelReport renders every section header and no empty candidate lines when none tracked', async () => {
    const report = await mod.buildTradingFunnelReport(new Date('2026-08-27T00:00:00.000Z').toISOString());
    const text = mod.formatTradingFunnelReport(report);
    expect(text).toContain('ARGUS TRADING FUNNEL');
    expect(text).toContain('CANDIDATES (in-memory lifecycle, current)');
    expect(text).toContain('(none tracked)');
    expect(text).toContain('AGENT EVALUATIONS / VOTES');
    expect(text).toContain('SAME-CANDIDATE / INDEPENDENCE');
    expect(text).toContain('CALIBRATION / CONSENSUS');
    expect(text).toContain('RISK / OMS / FILLS');
    expect(text).toContain('PROVIDER HEALTH');
  });
});
