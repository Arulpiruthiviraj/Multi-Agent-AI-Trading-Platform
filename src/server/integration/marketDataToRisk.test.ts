import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test: no per-module mocks. Feeds a real MARKET_DATA tick sequence through
 * the actual TechnicalAgent -> ChiefTraderAgent -> RiskAgent -> RiskEngine chain over the real
 * EventBus singleton, backed by a real (temporary, isolated) SQLite database - not the live
 * data/argus.db, per CLAUDE.md's warning against a second connection to that file.
 *
 * This exists because every other test in the repo mocks the DB/EventBus per-module, which
 * proves each module's own logic but never proves the modules are actually wired to each other
 * the way server.ts/SystemBootstrap.ts assembles them at boot.
 */
describe('Integration: MARKET_DATA -> TechnicalAgent -> ChiefTrader -> RiskAgent -> RiskEngine', () => {
  let tmpDbPath: string;
  let eventBus: any;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  const riskAssessments: any[] = [];

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_integration_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    // Dynamic imports, AFTER ARGUS_DB_PATH is set - db/index.ts reads it at module-load time,
    // and static imports would be hoisted/evaluated before this beforeAll body runs.
    ({ eventBus } = await import('../core/EventBus'));
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');

    // Force the non-debate path deterministically - otherwise whether ChiefTraderAgent attempts
    // an AI debate depends on the exact confidence value crossing 0.6, which this test shouldn't
    // have to know/care about. AIRouter has no registered providers in this test process anyway
    // (its own initialize() is never called), so a debate attempt would just fail over safely -
    // but forcing it off keeps this test about the real agent wiring, not AIRouter's failover.
    await db.insert(schema.settings).values({ adversarialDebateMode: false });

    eventBus.on('RISK_ASSESSMENT_COMPLETED', (a: any) => riskAssessments.push(a));

    // Real singletons, real constructors, real eventBus.on() subscriptions - the same modules
    // SystemBootstrap.ts wires together at real boot.
    await import('../services/TechnicalAgent');
    await import('../services/ChiefTraderAgent');
    await import('../services/RiskAgent');
    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
  });

  afterAll(() => {
    // better-sqlite3 holds an open file handle - deleting before closing it silently no-ops on
    // Windows (file locked) and leaks the temp file/-shm/-wal forever. Close first.
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('turns a real oversold price sequence into a real, evidenced risk assessment - no idea/consensus/risk data is mocked', async () => {
    // 49 flat ticks at 100, then one sharp drop to 10 on the 50th (the tick that fills
    // TechnicalAgent's 50-tick rolling window and triggers checkStrategies for the first time).
    // By hand: RSI collapses to exactly 0 (Wilder's average carries one dominant real loss, zero
    // real gains), and the drop lands price ~2.4 std below the last-20-tick Bollinger midline
    // (mean ~95.5, std ~19.6, lower band ~56.3, price 10) - comfortably firing the real
    // mean-reversion rule (rsi<30 && price<bb.lower) with confidence ~0.87, not a razor's-edge value.
    // EncryptionService.ts (pulled in transitively via RiskEngine -> BrokerManager) reloads
    // .env at module-load time, re-injecting the real ALPACA_API_KEY/SECRET_KEY into
    // process.env after beforeAll's delete - clear them again here, after all module-load
    // side effects have settled, so RiskEngine's market-hours check stays skipped (no real
    // Alpaca clock call) rather than depending on real-world market hours to pass.
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    const symbol = 'INTGTEST';
    for (let i = 0; i < 49; i++) {
      eventBus.emit('MARKET_DATA', { symbol, price: 100, volume: 1000, timestamp: new Date().toISOString() });
    }
    eventBus.emit('MARKET_DATA', { symbol, price: 10, volume: 1000, timestamp: new Date().toISOString() });

    // A professional trader needs a second independent source - TechnicalAgent alone is not
    // confirmation. Emit a real agreeing NewsAgent idea on the same symbol so ChiefTrader can
    // clear MIN_INDEPENDENT_AGREEING_AGENTS (adversarial debate is off in this test).
    eventBus.emitTradeIdea({
      traceId: 'intg-news-1',
      symbol,
      side: 'BUY',
      confidence: 0.8,
      currentPrice: 10,
      reasoning: 'Independent news confirmation for integration test.',
      agent: 'NewsAgent',
    });

    // The chain from here is real async DB-backed work (ChiefTraderAgent's settings read,
    // RiskEngine's broker/settings/trades/news-cluster reads) - poll instead of a single await.
    const deadline = Date.now() + 5000;
    while (riskAssessments.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    expect(riskAssessments.length).toBeGreaterThan(0);
    const assessment = riskAssessments[riskAssessments.length - 1];
    expect(assessment.symbol).toBe(symbol);
    expect(assessment.side).toBe('BUY');
    expect(typeof assessment.approved).toBe('boolean');
    expect(assessment.reasoning).toBeTruthy();
    // The InternalPaperBroker (real, in-memory, $100k default cash - no credentials needed) is
    // the active broker by default, so this should clear every sizing/concentration gate.
    expect(assessment.approved).toBe(true);
    expect(assessment.maxQuantity).toBeGreaterThan(0);
  });
});
