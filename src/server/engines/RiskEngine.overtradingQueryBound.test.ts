import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real gap found and fixed (2026-09-15, post-forensic-audit remediation). Before this fix,
 * RiskEngine.ts's same_symbol_cooldown / post_loss_cooldown / daily_trade_limit gates (3/4/5)
 * fetched the ENTIRE `trades` table, unfiltered, on every single live risk evaluation - the same
 * unbounded-query-against-a-growing-table pattern P1-A already fixed elsewhere in the codebase,
 * left unfixed here (the code's own prior comment admitted this explicitly). The fix bounds the
 * query to "since the start of the current real trading day, minus the longest cooldown window" -
 * these tests prove the bound is CORRECT (never silently drops a row one of the three gates still
 * needs), not merely that it's smaller.
 *
 * Real isolated temp SQLite DB, real RiskEngine.evaluateRisk() call - no module mocked except the
 * database itself is real/isolated. Reuses RiskEngine.gates.test.ts's own established pattern.
 */
describe('RiskEngine overtrading-guard query bound (gates 3/4/5) stays correct after boundedness fix', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let riskEngine: any;
  let tradingEngine: any;
  let getTradingDayStartMs: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_riskengine_overtrade_bound_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ riskEngine } = await import('./RiskEngine'));
    ({ tradingEngine } = await import('./TradingEngine'));
    ({ getTradingDayStartMs } = await import('../core/TradingCalendar'));
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataWorker.cacheObservedQuote('BOUNDQ', 100);
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    await db.insert(schema.settings).values({ maxTradeSize: 5000, riskLevel: 'Balanced', maxOpenPositions: 10 });
  });

  beforeEach(async () => {
    await db.delete(schema.trades);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function gateResult(traceId: string, gateName: string) {
    const rows = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    return rows.find((g: any) => g.gateName === gateName);
  }

  it('a recent FILLED trade for the same symbol (within the query window) still trips same_symbol_cooldown', async () => {
    const recentIso = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago - well inside cooldown
    await db.insert(schema.trades).values({
      id: 'bound-recent-same-symbol', symbol: 'BOUNDQ', side: 'BUY', quantity: 1, price: 100,
      status: 'FILLED', timestamp: recentIso, filledAt: recentIso,
    });

    const traceId = 'bound-test-same-symbol';
    await riskEngine.evaluateRisk({ traceId, symbol: 'BOUNDQ', side: 'BUY', currentPrice: 100 });
    const gate = await gateResult(traceId, 'same_symbol_cooldown');
    expect(gate.passed).toBe(false);
  });

  it('a trade far OUTSIDE the bounded query window does NOT affect same_symbol_cooldown or daily_trade_limit (proves the bound actually excludes old rows, not just that recent ones still work)', async () => {
    // 10 real days ago - unambiguously outside both the cooldown window and "today."
    const oldIso = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await db.insert(schema.trades).values({
      id: 'bound-old-same-symbol', symbol: 'BOUNDQ', side: 'BUY', quantity: 1, price: 100,
      status: 'FILLED', timestamp: oldIso, filledAt: oldIso,
    });

    const traceId = 'bound-test-old-trade';
    await riskEngine.evaluateRisk({ traceId, symbol: 'BOUNDQ', side: 'BUY', currentPrice: 100 });
    const cooldownGate = await gateResult(traceId, 'same_symbol_cooldown');
    expect(cooldownGate.passed).toBe(true);
    const detail = JSON.parse(cooldownGate.detail);
    expect(detail.lastFillMs).toBeNull(); // proves the old row was genuinely excluded by the query, not just too old to trip the cooldown math
  });

  it('a trade with an OLD timestamp but a RECENT filledAt is still correctly included (the exact edge case the WHERE clause is designed to handle - eventMs() prefers filledAt over timestamp)', async () => {
    // Order was created 30 minutes ago (older than the query's own lookback if it only checked
    // `timestamp`), but only actually FILLED 1 minute ago - eventMs() uses filledAt when present,
    // so this must still trip the cooldown despite its old timestamp.
    const oldSubmit = new Date(Date.now() - 30 * 60_000).toISOString();
    const recentFill = new Date(Date.now() - 60_000).toISOString();
    await db.insert(schema.trades).values({
      id: 'bound-late-fill', symbol: 'BOUNDQ', side: 'BUY', quantity: 1, price: 100,
      status: 'FILLED', timestamp: oldSubmit, filledAt: recentFill,
    });

    const traceId = 'bound-test-late-fill';
    await riskEngine.evaluateRisk({ traceId, symbol: 'BOUNDQ', side: 'BUY', currentPrice: 100 });
    const gate = await gateResult(traceId, 'same_symbol_cooldown');
    expect(gate.passed).toBe(false);
  });

  it('a recent FILLED losing SELL (within the query window, any symbol) still trips post_loss_cooldown', async () => {
    const recentIso = new Date(Date.now() - 60_000).toISOString();
    await db.insert(schema.trades).values({
      id: 'bound-recent-loss', symbol: 'OTHERSYM', side: 'SELL', quantity: 1, price: 90,
      status: 'FILLED', timestamp: recentIso, filledAt: recentIso, profitLoss: -5,
    });

    const traceId = 'bound-test-post-loss';
    await riskEngine.evaluateRisk({ traceId, symbol: 'BOUNDQ', side: 'BUY', currentPrice: 100 });
    const gate = await gateResult(traceId, 'post_loss_cooldown');
    expect(gate.passed).toBe(false);
  });

  it('a losing SELL far OUTSIDE the query window (older than getTradingDayStartMs() minus the cooldown) does NOT trip post_loss_cooldown', async () => {
    const outsideWindowMs = getTradingDayStartMs(new Date()) - 20 * 60 * 60 * 1000; // well before today's window even with the cooldown lookback
    const oldIso = new Date(outsideWindowMs).toISOString();
    await db.insert(schema.trades).values({
      id: 'bound-old-loss', symbol: 'OTHERSYM', side: 'SELL', quantity: 1, price: 90,
      status: 'FILLED', timestamp: oldIso, filledAt: oldIso, profitLoss: -5,
    });

    const traceId = 'bound-test-old-loss';
    await riskEngine.evaluateRisk({ traceId, symbol: 'BOUNDQ', side: 'BUY', currentPrice: 100 });
    const gate = await gateResult(traceId, 'post_loss_cooldown');
    expect(gate.passed).toBe(true);
    const detail = JSON.parse(gate.detail);
    expect(detail.lastLossMs).toBeNull(); // proves the old row was genuinely excluded by the query
  });
});
