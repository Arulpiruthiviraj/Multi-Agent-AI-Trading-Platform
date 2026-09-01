import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test (isolated temp SQLite DB) for the Discovery Lineage Ledger
 * (docs/audits/ARGUS_UNIVERSAL_DISCOVERY_PAPER_TRADING_FORENSIC_AUDIT_2026-09-01.md §8/§27 follow-up).
 * Every stage is seeded as a real, already-persisted row/event - never fabricated - matching the
 * exact convention rescueOutcomeReport.test.ts/explorationHealthReport.test.ts already established.
 */
describe('discoveryLineageReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./discoveryLineageReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_discovery_lineage_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./discoveryLineageReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  let seq = 0;
  function nextId(): string {
    seq += 1;
    return `dl-${seq}`;
  }

  it('a symbol with zero evidence in the window gets an honest "no evidence" summary, never a fabricated one', async () => {
    const report = await mod.buildDiscoveryLineageReport('NOEVIDENCE', new Date(Date.now() - 60_000).toISOString());
    expect(report.discoveryDecisions).toEqual([]);
    expect(report.terminalSummary).toMatch(/No discovery-lineage evidence/);
  });

  it('the FRVO-class case: admitted by discovery but never reaches a subscribe request in this window', async () => {
    const tsMs = Date.now();
    await db.insert(schema.observabilityEvents).values({
      id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CANDIDATE_ADMITTED',
      loggerName: 'argus', message: 'discovery_candidate_decision', sessionId: 'test-session', symbol: 'FRVOTEST',
      payload: JSON.stringify({ source: 'MARKET_MOVER', reason: null, price: 19.75, dollarVolume: 50_000_000, spreadBps: 10, advShares: 800_000 }),
    });
    const report = await mod.buildDiscoveryLineageReport('FRVOTEST', new Date(tsMs - 60_000).toISOString());
    expect(report.discoveryDecisions).toHaveLength(1);
    expect(report.discoveryDecisions[0].admitted).toBe(true);
    expect(report.discoveryDecisions[0].source).toBe('MARKET_MOVER');
    expect(report.subscribeRequestedCount).toBe(0);
    expect(report.terminalSummary).toMatch(/Admitted by discovery but never reached a recorded subscription/);
  });

  it('a symbol filtered at discovery reports the real reason, never a guess', async () => {
    const tsMs = Date.now();
    await db.insert(schema.observabilityEvents).values({
      id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CANDIDATE_FILTERED',
      loggerName: 'argus', message: 'discovery_candidate_decision', sessionId: 'test-session', symbol: 'GPROTEST',
      payload: JSON.stringify({ source: 'MARKET_MOVER', reason: 'PRICE', price: 1.56, dollarVolume: 900_000, spreadBps: null, advShares: null }),
    });
    const report = await mod.buildDiscoveryLineageReport('GPROTEST', new Date(tsMs - 60_000).toISOString());
    expect(report.discoveryDecisions[0].reason).toBe('PRICE');
    expect(report.terminalSummary).toMatch(/Filtered at discovery \(PRICE\)/);
  });

  it('full success chain: admitted -> subscribed -> evaluated -> idea -> consensus approved -> risk approved -> real fill', async () => {
    const tsMs = Date.now();
    const symbol = 'SUCCESSTEST';
    await db.insert(schema.observabilityEvents).values([
      { id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CANDIDATE_ADMITTED', loggerName: 'argus', message: 'm', sessionId: 's', symbol, payload: JSON.stringify({ source: 'MARKET_MOVER', reason: null }) },
      { id: nextId(), ts: tsMs + 1, level: 'INFO', category: 'EVENTBUS', eventType: 'WATCHLIST_SUBSCRIBE_REQUESTED', loggerName: 'argus', message: 'm', sessionId: 's', symbol, payload: null },
      { id: nextId(), ts: tsMs + 2, level: 'INFO', category: 'EVENTBUS', eventType: 'TRADE_IDEA_GENERATED', loggerName: 'argus', message: 'm', sessionId: 's', symbol, payload: null },
      { id: nextId(), ts: tsMs + 3, level: 'INFO', category: 'CONSENSUS', eventType: 'CONSENSUS_TERMINAL_REASON', loggerName: 'argus', message: 'm', sessionId: 's', symbol, payload: JSON.stringify({ approved: true }) },
    ]);
    await db.insert(schema.quantAssessments).values({
      id: nextId(), symbol, timeframe: '1Min', regime: '{}', marketContext: '{}', emittedTradeIdea: true, createdAt: new Date(tsMs).toISOString(),
    });
    await db.insert(schema.riskAssessments).values({
      traceId: nextId(), symbol, side: 'BUY', approved: true, maxQuantity: 10, createdAt: new Date(tsMs + 4).toISOString(),
    });
    await db.insert(schema.trades).values({
      id: nextId(), symbol, side: 'BUY', quantity: 10, price: 100, status: 'FILLED', timestamp: new Date(tsMs + 5).toISOString(), executionEnvironment: 'PAPER',
    });

    const report = await mod.buildDiscoveryLineageReport(symbol, new Date(tsMs - 60_000).toISOString());
    expect(report.subscribeRequestedCount).toBe(1);
    expect(report.quantEvaluationCount).toBe(1);
    expect(report.ideaEmittedCount).toBe(1);
    expect(report.consensusApprovedCount).toBe(1);
    expect(report.riskEngineReached).toBe(true);
    expect(report.riskApproved).toBe(true);
    expect(report.omsOrderPlaced).toBe(true);
    expect(report.fillReached).toBe(true);
    expect(report.terminalSummary).toMatch(/real \(non-REPLAY\) fill/);
  });

  it('a REPLAY-tagged trade sharing the same symbol is excluded from riskEngineReached/omsOrderPlaced/fillReached', async () => {
    const tsMs = Date.now();
    const symbol = 'REPLAYTEST';
    await db.insert(schema.trades).values({
      id: nextId(), symbol, side: 'BUY', quantity: 10, price: 100, status: 'FILLED', timestamp: new Date(tsMs).toISOString(), executionEnvironment: 'REPLAY', brokerId: 'historical_replay',
    });
    const report = await mod.buildDiscoveryLineageReport(symbol, new Date(tsMs - 60_000).toISOString());
    expect(report.omsOrderPlaced).toBe(false);
    expect(report.fillReached).toBe(false);
  });

  it('formatDiscoveryLineageReport renders without crashing', async () => {
    const report = await mod.buildDiscoveryLineageReport('ANYSYMBOL', new Date(Date.now() - 60_000).toISOString());
    const text = mod.formatDiscoveryLineageReport(report);
    expect(text).toContain('DISCOVERY LINEAGE');
    expect(text).toContain('TERMINAL SUMMARY');
  });
});
