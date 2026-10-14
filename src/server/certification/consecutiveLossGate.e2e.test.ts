// LABEL: GATE_CERTIFIED (real RiskEngine against an isolated PAPER-equivalent ledger; SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY)
/**
 * consecutive_loss (gate 9) deliberately ignores REPLAY / BACKTEST trades, so a synthetic market session can never trip it. Its behaviour is
 * therefore certified HERE, at gate level, on an isolated PAPER ledger - reported as GATE_CERTIFIED, not FULL_SESSION_EXERCISED. The
 * replay-isolation boundary itself is also asserted (REPLAY losses must NOT count).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

describe('consecutive_loss gate (gate-level certification)', () => {
  let tmp: string; let db: any; let sqliteDb: any; let schema: any;
  let riskEngine: any; let BrokerManager: any; let tradingEngine: any; let marketDataWorker: any; let generateTraceId: any;
  let maxLosses: number; let lookbackMs: number; let ticker: any;
  let seq = 0;

  const insertSell = async (o: { pnl: number; ageMs: number; env: 'PAPER' | 'REPLAY' }) => {
    const iso = new Date(Date.now() - o.ageMs).toISOString();
    await db.insert(schema.trades).values({
      id: `cl-${++seq}`, symbol: 'AAPL', side: 'SELL', quantity: 1, price: 100, status: 'FILLED', timestamp: iso, filledAt: iso, submittedAt: iso,
      traceId: `cl-trace-${seq}`, profitLoss: o.pnl, brokerId: 'internal_paper', executionEnvironment: o.env, brokerOrderId: `cl-b-${seq}`,
    });
  };
  const gateAfterBuy = async () => {
    const traceId = generateTraceId('MSFT');
    await riskEngine.evaluateRisk({ traceId, symbol: 'MSFT', side: 'BUY', currentPrice: 92 });
    const rows = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    return rows.find((r: any) => r.gateName === 'consecutive_loss');
  };

  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_consec_loss_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.LIVE_ARM;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    await import('../services/RiskAgent');
    ({ riskEngine } = await import('../engines/RiskEngine'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));
    ({ generateTraceId } = await import('../core/traceId'));
    const { tradingSafety } = await import('../config/tradingSafety');
    maxLosses = tradingSafety.maxConsecutiveLosses; lookbackMs = tradingSafety.consecutiveLossLookbackMs;
    await db.insert(schema.settings).values({ tradingMode: 'Paper', autoBotEnabled: true, budget: 20000, maxTradeSize: 1000, maxOrdersPerMinute: 100 });
    tradingEngine.state.enabled = true;
    await BrokerManager.getInstance().initialize();
    delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY;
    expect(await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 })).toBe(true);
    ticker = setInterval(() => { marketDataWorker.cacheObservedQuote('MSFT', 92); BrokerManager.getInstance().tick({ MSFT: 92 }); }, 100);
  });
  afterAll(() => {
    if (ticker) clearInterval(ticker);
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });
  beforeEach(async () => { await db.delete(schema.trades); });

  it('N recent PAPER losing closes -> the gate FAILS (new BUY blocked)', async () => {
    for (let i = 0; i < maxLosses; i++) await insertSell({ pnl: -10 - i, ageMs: 60_000 * (i + 1), env: 'PAPER' });
    const g = await gateAfterBuy();
    expect(g, 'gate recorded').toBeTruthy();
    expect(!!g.passed).toBe(false);
  }, 60000);

  it('a winner among the last N closes -> the gate PASSES', async () => {
    for (let i = 0; i < maxLosses - 1; i++) await insertSell({ pnl: -10, ageMs: 60_000 * (i + 2), env: 'PAPER' });
    await insertSell({ pnl: +25, ageMs: 30_000, env: 'PAPER' });
    expect(!!(await gateAfterBuy()).passed).toBe(true);
  }, 60000);

  it('losses older than the lookback do not count (a stale streak cannot block forever)', async () => {
    for (let i = 0; i < maxLosses; i++) await insertSell({ pnl: -10, ageMs: lookbackMs + 3_600_000 + i * 1000, env: 'PAPER' });
    expect(!!(await gateAfterBuy()).passed).toBe(true);
  }, 60000);

  it('REPLAY-environment losses never count: the replay isolation boundary is preserved', async () => {
    for (let i = 0; i < maxLosses + 2; i++) await insertSell({ pnl: -10, ageMs: 60_000 * (i + 1), env: 'REPLAY' });
    expect(!!(await gateAfterBuy()).passed).toBe(true);
  }, 60000);

  it('fewer than N closes in total -> PASS (no real history of a streak)', async () => {
    for (let i = 0; i < maxLosses - 1; i++) await insertSell({ pnl: -10, ageMs: 60_000 * (i + 1), env: 'PAPER' });
    expect(!!(await gateAfterBuy()).passed).toBe(true);
  }, 60000);
});
