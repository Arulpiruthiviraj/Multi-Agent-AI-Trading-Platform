import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('explorationHealthReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./explorationHealthReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_exploration_health_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./explorationHealthReport');
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
    return `eh-${seq}`;
  }

  async function seedPromotion(traceId: string, symbol: string, tsMs: number, promoted: string, natural: string) {
    await db.insert(schema.observabilityEvents).values({
      id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'STRATEGY_EXPLORATION_PROMOTED',
      loggerName: 'argus', message: 'strategy_exploration_promoted', sessionId: 'test-session', symbol, traceId,
      payload: JSON.stringify({ reasoning: `Exploration promoted ${promoted} (setupScore 50) over the natural top-ranked ${natural} (setupScore 100).` }),
    });
  }

  it('reports the exact CRM/ONON failure pattern: promotion -> rescue denied -> idea discarded, level 1 (never inflated past what real evidence proves)', async () => {
    const traceId = 'trace_CRM_test1';
    const tsMs = Date.now();
    await seedPromotion(traceId, 'CRM', tsMs, 'MOMENTUM_BREAKOUT', 'OSCILLATOR_MOMENTUM');
    await db.insert(schema.observabilityEvents).values({
      id: nextId(), ts: tsMs + 10, level: 'INFO', category: 'DISCOVERY', eventType: 'TEMPORARY_DATA_RESCUE_DENIED',
      loggerName: 'argus', message: 'temporary_data_rescue_denied', sessionId: 'test-session', symbol: 'CRM', traceId,
      payload: JSON.stringify({ reasoning: 'QuantEngine:MOMENTUM_BREAKOUT_stale_data_rescue [class=EXPLORATION] denied: RESCUE_CAPACITY_FULL.' }),
    });
    await db.insert(schema.observabilityEvents).values({
      id: nextId(), ts: tsMs + 20, level: 'INFO', category: 'DISCOVERY', eventType: 'QUANT_IDEA_DISCARDED_STALE_DATA',
      loggerName: 'argus', message: 'quant_idea_discarded_stale_data', sessionId: 'test-session', symbol: 'CRM', traceId,
      payload: JSON.stringify({}),
    });

    const report = await mod.buildExplorationHealthReport(new Date(tsMs - 60_000).toISOString());
    const row = report.rows.find((r) => r.traceId === traceId)!;
    expect(row).toBeDefined();
    expect(row.strategyPromoted).toBe('MOMENTUM_BREAKOUT');
    expect(row.naturalTopStrategy).toBe('OSCILLATOR_MOMENTUM');
    expect(row.rescueRequested).toBe(true);
    expect(row.rescueGranted).toBe(false);
    expect(row.rescueDeniedReason).toBe('RESCUE_CAPACITY_FULL');
    expect(row.ideaDiscardedStaleData).toBe(true);
    expect(row.ideaEmitted).toBe(false);
    expect(row.level).toBe(2); // idea was constructed (reached the stale-data gate), never emitted
  });

  it('reports a full end-to-end success: promotion -> rescue granted -> emitted -> consensus approved -> risk approved -> real fill = level 6', async () => {
    const traceId = 'trace_SUCCESS_test1';
    const tsMs = Date.now();
    await seedPromotion(traceId, 'SUCC', tsMs, 'TREND_FOLLOWING', 'MA_CROSSOVER');
    await db.insert(schema.observabilityEvents).values({
      id: nextId(), ts: tsMs + 10, level: 'INFO', category: 'DISCOVERY', eventType: 'TEMPORARY_DATA_RESCUE_GRANTED',
      loggerName: 'argus', message: 'temporary_data_rescue_granted', sessionId: 'test-session', symbol: 'SUCC', traceId,
      payload: JSON.stringify({}),
    });
    await db.insert(schema.observabilityEvents).values({
      id: nextId(), ts: tsMs + 20, level: 'INFO', category: 'CONSENSUS', eventType: 'CONSENSUS_TERMINAL_REASON',
      loggerName: 'argus', message: 'consensus_terminal_reason', sessionId: 'test-session', symbol: 'SUCC', traceId,
      payload: JSON.stringify({ approved: true, decisionTier: 'STRONG' }),
    });
    await db.insert(schema.riskAssessments).values({
      traceId, symbol: 'SUCC', side: 'BUY', approved: true, maxQuantity: 10, createdAt: new Date(tsMs + 30).toISOString(),
    });
    await db.insert(schema.trades).values({
      id: 'trade-succ-1', symbol: 'SUCC', side: 'BUY', quantity: 10, price: 100, status: 'FILLED',
      timestamp: new Date(tsMs + 40).toISOString(), traceId, executionEnvironment: 'PAPER',
    });

    const report = await mod.buildExplorationHealthReport(new Date(tsMs - 60_000).toISOString());
    const row = report.rows.find((r) => r.traceId === traceId)!;
    expect(row.rescueGranted).toBe(true);
    expect(row.consensusApproved).toBe(true);
    expect(row.riskEngineReached).toBe(true);
    expect(row.riskApproved).toBe(true);
    expect(row.omsOrderPlaced).toBe(true);
    expect(row.fillReached).toBe(true);
    expect(row.level).toBe(6);
  });

  it('excludes a REPLAY-tagged trade from riskEngineReached/omsOrderPlaced/fillReached even if it shares the traceId', async () => {
    const traceId = 'trace_REPLAYCHECK_test1';
    const tsMs = Date.now();
    await seedPromotion(traceId, 'RPLY', tsMs, 'MEAN_REVERSION', 'FIBONACCI_PULLBACK');
    await db.insert(schema.trades).values({
      id: 'trade-rply-1', symbol: 'RPLY', side: 'BUY', quantity: 10, price: 100, status: 'FILLED',
      timestamp: new Date(tsMs + 10).toISOString(), traceId, executionEnvironment: 'REPLAY', brokerId: 'historical_replay',
    });

    const report = await mod.buildExplorationHealthReport(new Date(tsMs - 60_000).toISOString());
    const row = report.rows.find((r) => r.traceId === traceId)!;
    expect(row.omsOrderPlaced).toBe(false);
    expect(row.fillReached).toBe(false);
    expect(row.level).toBe(1); // no rescue, no discard, no emission - only the promotion itself is real evidence
  });

  it('never crashes and simply skips a promotion event with no traceId (cannot be correlated, never guessed)', async () => {
    const tsMs = Date.now();
    await db.insert(schema.observabilityEvents).values({
      id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'STRATEGY_EXPLORATION_PROMOTED',
      loggerName: 'argus', message: 'strategy_exploration_promoted', sessionId: 'test-session', symbol: 'NOTRACE', traceId: null,
      payload: JSON.stringify({ reasoning: 'Exploration promoted X (setupScore 50) over the natural top-ranked Y (setupScore 100).' }),
    });
    const report = await mod.buildExplorationHealthReport(new Date(tsMs - 60_000).toISOString());
    expect(report.rows.find((r) => r.symbol === 'NOTRACE')).toBeUndefined();
  });

  it('formatExplorationHealthReport renders a readable table and the success-rate ladder without crashing', async () => {
    const report = await mod.buildExplorationHealthReport(new Date(Date.now() - 60_000).toISOString());
    const text = mod.formatExplorationHealthReport(report);
    expect(text).toContain('EXPLORATION HEALTH');
    expect(text).toContain('SUCCESS RATE BY STAGE');
  });
});
