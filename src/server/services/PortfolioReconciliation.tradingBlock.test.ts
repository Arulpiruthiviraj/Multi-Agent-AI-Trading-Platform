import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Phase 1, item 1 (ARGUS_SAFETY_HARDENING_REPORT.md / ARGUS_PRE_IMPLEMENTATION_BASELINE.md).
 *
 * The current audit (FINAL_ANALYSIS.md Section 30.12) found that PortfolioReconciliation's
 * documented "pauses trading on a large mismatch" behavior did NOT actually reach RiskEngine's
 * real emergency_stop gate - it set `tradingEngine.state.emergencyStopActive` directly, a field
 * the gate never reads. This test proves the FIX end-to-end, not merely that a flag changes:
 *
 *   BROKER MISMATCH -> RECONCILIATION -> TRADING BLOCKED -> RISK ENGINE REJECTS NEW ORDER
 *
 * Real isolated temp SQLite DB, real BrokerManager singleton (defaults to InternalPaperBroker,
 * no external credentials needed), real RiskEngine.evaluateRisk() call - no module is mocked.
 */
describe('Portfolio reconciliation mismatch actually blocks new orders (Phase 1 fix)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let riskEngine: any;
  let tradingEngine: any;
  let portfolioReconciliationWorker: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reconcile_block_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ riskEngine } = await import('../engines/RiskEngine'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ portfolioReconciliationWorker } = await import('./PortfolioReconciliation'));
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const { marketDataWorker } = await import('./MarketDataWorker');
    marketDataWorker.cacheObservedQuote('AAPL', 150);
    marketDataWorker.cacheObservedQuote('MSFT', 300);

    // Same real-world dotenv-reload hazard RiskEngine.gates.test.ts already documents and works
    // around: delete AFTER the import chain has already triggered any dotenv reload, so
    // isMarketOpen() short-circuits instead of hitting the real Alpaca clock API.
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    await db.insert(schema.settings).values({ maxTradeSize: 5000, riskLevel: 'Balanced', maxOpenPositions: 10 });
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('a significant real position mismatch pauses tradingState AND RiskEngine actually rejects the next proposal at emergency_stop', async () => {
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');

    // Baseline: before any mismatch, a proposal must NOT be rejected at the emergency_stop gate
    // specifically (it may still be rejected by other gates, e.g. insufficient size against the
    // paper broker's real starting cash - that's fine and not what this test is about).
    const baselineTraceId = 'reconcile-block-baseline';
    await riskEngine.evaluateRisk({ traceId: baselineTraceId, symbol: 'AAPL', side: 'BUY', currentPrice: 150 });
    const [baseline] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, baselineTraceId));
    expect(baseline.rejectionGate).not.toBe('emergency_stop');

    // Real broker mismatch: the active broker reports a position the local DB has never heard of,
    // well above the $100 SIGNIFICANT_MISMATCH_DOLLARS threshold.
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => {
      const real = await originalPortfolio();
      return { ...real, positions: [...real.positions, { symbol: 'MISMATCHCO', quantity: 100, entryPrice: 50, currentPrice: 50 }] };
    };

    await portfolioReconciliationWorker.reconcile();

    // The real, previously-broken assertion: tradingState itself must actually change.
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');

    // A real, persisted kill-switch audit row must exist for this transition.
    const killSwitchRows = await db.select().from(schema.killSwitchEvents);
    const last = killSwitchRows[killSwitchRows.length - 1];
    expect(last.toState).toBe('TRADING_PAUSED');
    expect(last.actor).toBe('system:PortfolioReconciliation');

    // The actual order-blocking behavior, not just the flag: a brand new proposal, for a
    // completely unrelated symbol, must now be rejected specifically at emergency_stop.
    const blockedTraceId = 'reconcile-block-after-mismatch';
    await riskEngine.evaluateRisk({ traceId: blockedTraceId, symbol: 'MSFT', side: 'BUY', currentPrice: 300 });
    const [blocked] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, blockedTraceId));
    expect(blocked.approved).toBe(false);
    expect(blocked.rejectionGate).toBe('emergency_stop');

    const gateRows = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, blockedTraceId));
    const emergencyGate = gateRows.find((g: any) => g.gateName === 'emergency_stop');
    expect(emergencyGate.passed).toBe(false);

    // Cleanup: restore trading so this doesn't leak into any later test file execution order
    // within the same process (each test file gets its own temp DB/module registry, but the
    // resumption call itself is worth proving works too).
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test cleanup', actor: 'test' });
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');

    (broker as any).portfolio = originalPortfolio;
  });
});
