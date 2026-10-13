// LABEL: MECHANISM_E2E (real services + simulated internal_paper broker; SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY)
/**
 * 2026-10-13 protective exit while entries are paused - the end-to-end proof the unit tests could not give.
 *
 * Unit tests proved each link (RiskEngine gate 1, OMS submit check, pause persistence). This drives the SAME production entry
 * point a real exit takes - chiefTrader.reviewIdea() with a PortfolioManager SELL carrying a PortfolioMonitor-minted seal -
 * through the real ChiefTrader, RiskAgent, RiskEngine, PositionSizing and OrderManagement into the internal_paper broker, with a
 * CARRIED position (opened at the simulated broker boundary as environment setup, exactly as a position carried past a
 * restart). Nothing forces an approval or a fill: the controls prove the pause still blocks what it must.
 *
 *   ENTRIES_ONLY + sealed protective SELL  -> FILLED, position flat
 *   ENTRIES_ONLY + BUY                     -> blocked (emergency_stop gate)
 *   ENTRIES_ONLY + unsealed SELL           -> blocked
 *   FULL pause + sealed protective SELL    -> blocked
 *   EMERGENCY_STOP + sealed SELL           -> blocked
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

describe('protective exit under an ENTRIES_ONLY pause (real spine, simulated broker)', () => {
  let tmp: string; let db: any; let sqliteDb: any; let schema: any;
  let chiefTrader: any; let BrokerManager: any; let tradingEngine: any; let marketDataWorker: any; let eventBus: any;
  let mintProtectiveExitSeal: any; let PROTECTIVE_EXIT_AUTHORIZED_MINTER: any; let generateTraceId: any;
  let ticker: any;
  const PRICE = 92; // the carried AAPL position was opened at 100: a -8% hard-stop situation
  const approvals: any[] = [];

  const waitFor = async (cond: () => Promise<boolean> | boolean, ms: number, label: string) => {
    const end = Date.now() + ms;
    for (;;) { if (await cond()) return; if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise((r) => setTimeout(r, 80)); }
  };

  async function carryPosition(symbol: string, qty: number) {
    const broker = BrokerManager.getInstance().getActiveBroker();
    // environment setup at the simulated broker boundary: a carried position (not a strategy signal, not an approval)
    await broker.placeOrder({ symbol, side: 'BUY', type: 'MARKET', quantity: qty, clientOrderId: `carry-${symbol}-${Date.now()}` });
    BrokerManager.getInstance().tick({ [symbol]: PRICE });
    marketDataWorker.cacheObservedQuote(symbol, PRICE);
    // The position's ledger lineage, as a position carried past a restart would have it: the original BUY order row and its
    // fill with the post-fill position baseline OMS's prepareOrderPosition() validates a SELL against (no baseline -> refused).
    const nowIso = new Date().toISOString();
    const orderId = `carry-order-${symbol}`;
    await db.insert(schema.trades).values({
      id: orderId, symbol, side: 'BUY', quantity: qty, price: 100, status: 'FILLED', timestamp: nowIso, traceId: `carry-trace-${symbol}`,
      filledAt: nowIso, submittedAt: nowIso, brokerId: 'internal_paper', executionEnvironment: 'PAPER', brokerOrderId: `carry-broker-${symbol}`,
      reasoning: 'carried position fixture (SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY)',
    });
    await db.insert(schema.fills).values({
      orderId, brokerFillId: `carry-fill-${symbol}`, quantity: qty, price: 100, filledAt: nowIso, cumulativeQuantity: qty,
      positionQuantityAfter: qty, positionAveragePriceAfter: 100, realizedPnl: 0,
    });
  }
  const brokerQty = async (symbol: string) => {
    const positions = await BrokerManager.getInstance().getActiveBroker().positions();
    return positions.find((p: any) => p.symbol === symbol)?.quantity ?? 0;
  };
  const exitIdea = (symbol: string, sealed: boolean) => {
    const traceId = generateTraceId(symbol);
    return {
      traceId, symbol, side: 'SELL', confidence: 0.95, currentPrice: PRICE,
      reasoning: '[Risk Exit] EXIT_CODE=HARD_STOP Hard stop hit (-8.00%, threshold -5%). SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY',
      agent: 'PortfolioManager', origin: 'PORTFOLIO_EXIT',
      ...(sealed ? { protectiveExitSeal: mintProtectiveExitSeal({ traceId, symbol, mintedBy: PROTECTIVE_EXIT_AUTHORIZED_MINTER }) } : {}),
    };
  };
  const assessmentFor = async (traceId: string) => (await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId)))[0];
  const gateOf = async (traceId: string, gate: string) => {
    const rows = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    const r = rows.find((x: any) => x.gateName === gate);
    return r ? { passed: !!r.passed, detail: r.detail ? JSON.parse(r.detail) : {} } : null;
  };

  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_exit_pause_e2e_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.LIVE_ARM; delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    ({ chiefTrader } = await import('../services/ChiefTraderAgent'));
    await import('../services/RiskAgent');
    await import('../services/OrderManagement');
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));
    ({ mintProtectiveExitSeal, PROTECTIVE_EXIT_AUTHORIZED_MINTER } = await import('../core/protectiveExitSeal'));
    ({ generateTraceId } = await import('../core/traceId'));
    await db.insert(schema.settings).values({ tradingMode: 'Paper', autoBotEnabled: true, budget: 20000, maxTradeSize: 1000, maxOrdersPerMinute: 100 });
    tradingEngine.state.enabled = true;
    await BrokerManager.getInstance().initialize();
    delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY;
    expect(await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 })).toBe(true);
    eventBus.on('CHIEF_APPROVED_IDEA', (a: any) => approvals.push(a));
    ticker = setInterval(() => {
      for (const s of ['AAPL', 'MSFT', 'NVDA', 'AMD', 'META']) {
        marketDataWorker.cacheObservedQuote(s, PRICE);
        BrokerManager.getInstance().tick({ [s]: PRICE });
      }
    }, 100);
  });
  afterAll(() => {
    if (ticker) clearInterval(ticker);
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });

  it('ENTRIES_ONLY pause: a sealed protective SELL of a carried position is approved by RiskEngine, submitted by OMS and FILLED; the position is flat', async () => {
    await carryPosition('AAPL', 10);
    expect(await brokerQty('AAPL')).toBe(10);
    await tradingEngine.setTradingState('TRADING_PAUSED', { reason: 'e2e entries-only pause', actor: 'test', pauseKind: 'ENTRIES_ONLY' });
    const idea = exitIdea('AAPL', true);
    await chiefTrader.reviewIdea(idea);
    try {
      await waitFor(async () => {
        const t = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, idea.traceId)))[0];
        return !!t && t.status === 'FILLED';
      }, 45000, 'protective SELL FILLED under ENTRIES_ONLY pause');
    } catch (e) {
      const a0 = await assessmentFor(idea.traceId);
      const t0 = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, idea.traceId)))[0];
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, idea.traceId));
      throw new Error(`${(e as Error).message} | approvedByChief=${approvals.some((x) => x.traceId === idea.traceId)} assessment=${JSON.stringify(a0)} trade=${JSON.stringify(t0)} failedGates=${JSON.stringify(gates.filter((g: any) => !g.passed).map((g: any) => [g.gateName, g.detail]))}`);
    }
    const a = await assessmentFor(idea.traceId);
    expect(a.approved).toBeTruthy();
    const gate1 = await gateOf(idea.traceId, 'emergency_stop');
    expect(gate1?.passed).toBe(true);
    expect(gate1?.detail).toMatchObject({ tradingState: 'TRADING_PAUSED', pauseKind: 'ENTRIES_ONLY', protectiveExitExempt: true });
    // every OTHER mandatory SELL gate was still evaluated and passed
    expect((await gateOf(idea.traceId, 'sell_position_exists'))?.passed).toBe(true);
    expect((await gateOf(idea.traceId, 'price_validity'))?.passed).toBe(true);
    expect(await brokerQty('AAPL')).toBe(0);
    const t = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, idea.traceId)))[0];
    expect(t).toMatchObject({ side: 'SELL', status: 'FILLED', executionEnvironment: 'PAPER' });
    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, t.id));
    expect(fillRows).toHaveLength(1); // exactly one explainable lineage: trace -> order -> one fill
  }, 90000);

  it('control: under the same ENTRIES_ONLY pause a BUY is blocked at the emergency_stop gate and nothing reaches the broker', async () => {
    await tradingEngine.setTradingState('TRADING_PAUSED', { reason: 'e2e entries-only pause', actor: 'test', pauseKind: 'ENTRIES_ONLY' });
    const traceId = generateTraceId('MSFT');
    // a BUY goes through RiskEngine directly (consensus is not the subject here): same engine the OMS path uses
    const { riskEngine } = await import('../engines/RiskEngine');
    await riskEngine.evaluateRisk({ traceId, symbol: 'MSFT', side: 'BUY', currentPrice: PRICE });
    const a = await assessmentFor(traceId);
    expect(a.approved).toBeFalsy();
    expect(a.rejectionGate).toBe('emergency_stop');
    expect(await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId))).toHaveLength(0);
  }, 60000);

  it('control: an UNSEALED SELL of a held position is blocked under ENTRIES_ONLY (only a sealed protective exit passes)', async () => {
    await carryPosition('NVDA', 5);
    await tradingEngine.setTradingState('TRADING_PAUSED', { reason: 'e2e entries-only pause', actor: 'test', pauseKind: 'ENTRIES_ONLY' });
    const idea = exitIdea('NVDA', false);
    const { riskEngine } = await import('../engines/RiskEngine');
    await riskEngine.evaluateRisk({ traceId: idea.traceId, symbol: 'NVDA', side: 'SELL', currentPrice: PRICE });
    const a = await assessmentFor(idea.traceId);
    expect(a.approved).toBeFalsy();
    expect(a.rejectionGate).toBe('emergency_stop');
    expect(await brokerQty('NVDA')).toBe(5);
  }, 60000);

  it('control: a FULL pause and EMERGENCY_STOP block even a sealed protective SELL', async () => {
    await carryPosition('AMD', 4);
    const { riskEngine } = await import('../engines/RiskEngine');
    for (const [state, kind] of [['TRADING_PAUSED', 'FULL'], ['EMERGENCY_STOP', 'ENTRIES_ONLY']] as const) {
      await tradingEngine.setTradingState(state, { reason: `e2e ${state}`, actor: 'test', pauseKind: kind });
      const idea = exitIdea('AMD', true);
      await riskEngine.evaluateRisk({ traceId: idea.traceId, symbol: 'AMD', side: 'SELL', currentPrice: PRICE, protectiveExitSeal: idea.protectiveExitSeal });
      const a = await assessmentFor(idea.traceId);
      expect(a.approved, state).toBeFalsy();
      expect(a.rejectionGate, state).toBe('emergency_stop');
    }
    expect(await brokerQty('AMD')).toBe(4); // untouched
  }, 60000);
});
