// LABEL: MECHANISM_E2E (real services + simulated internal_paper broker with an order-lifecycle fault layer; SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY)
/**
 * 2026-10-13 broker order-lifecycle faults through the REAL spine.
 *
 * Each case drives a sealed protective SELL of a carried position through the real ChiefTrader -> RiskAgent -> RiskEngine ->
 * PositionSizing -> OrderManagement path into the simulated broker, with FaultInjectingBroker changing only how the broker REPORTS and
 * TIMES the order (delayed fill, partial fill, reject, cancel, unknown-after-submit, duplicate / stale events). Nothing forces an
 * approval or a fill. The invariant checked in every case is the one that matters in production:
 *
 *   restart / timeout / duplicate events may delay action, but must never create DUPLICATE EXPOSURE or lose BROKER TRUTH:
 *   exactly one logical order reaches the broker, the ledger fills equal what the broker really executed, the local position equals the
 *   broker position, and no second order is placed to "retry".
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import { installBrokerFaults, type FaultInjectionController, type FaultSpec } from '../replay/synthetic/FaultInjectingBroker';

describe('broker order-lifecycle faults (real spine, simulated broker + fault layer)', () => {
  let tmp: string; let db: any; let sqliteDb: any; let schema: any;
  let chiefTrader: any; let BrokerManager: any; let tradingEngine: any; let marketDataWorker: any; let oms: any;
  let mintProtectiveExitSeal: any; let PROTECTIVE_EXIT_AUTHORIZED_MINTER: any; let generateTraceId: any;
  let ticker: any;
  let faults: FaultInjectionController | null = null;
  const PRICE = 92;
  let symbolSeq = 0;
  const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'GOOGL', 'AMZN', 'TSLA', 'QQQ', 'SPY'];

  const waitFor = async (cond: () => Promise<boolean> | boolean, ms: number, label: string) => {
    const end = Date.now() + ms;
    for (;;) { if (await cond()) return; if (Date.now() > end) throw new Error(`timed out: ${label} | ${(globalThis as any).__faultDiag ?? ''}`); await new Promise((r) => setTimeout(r, 80)); }
  };
  const nextSymbol = () => SYMBOLS[symbolSeq++ % SYMBOLS.length];
  const broker = () => BrokerManager.getInstance().getActiveBroker();
  const brokerQty = async (symbol: string) => (await broker().positions()).find((p: any) => p.symbol === symbol)?.quantity ?? 0;

  async function carryPosition(symbol: string, qty: number) {
    await broker().placeOrder({ symbol, side: 'BUY', type: 'MARKET', quantity: qty, clientOrderId: `carry-${symbol}-${Date.now()}` });
    BrokerManager.getInstance().tick({ [symbol]: PRICE });
    marketDataWorker.cacheObservedQuote(symbol, PRICE);
    const nowIso = new Date().toISOString();
    const orderId = `carry-order-${symbol}-${symbolSeq}`;
    await db.insert(schema.trades).values({
      id: orderId, symbol, side: 'BUY', quantity: qty, price: 100, status: 'FILLED', timestamp: nowIso, traceId: `carry-trace-${orderId}`,
      filledAt: nowIso, submittedAt: nowIso, brokerId: 'internal_paper', executionEnvironment: 'PAPER', brokerOrderId: `carry-broker-${orderId}`,
      reasoning: 'carried position fixture (SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY)',
    });
    await db.insert(schema.fills).values({
      orderId, brokerFillId: `carry-fill-${orderId}`, quantity: qty, price: 100, filledAt: nowIso, cumulativeQuantity: qty,
      positionQuantityAfter: qty, positionAveragePriceAfter: 100, realizedPnl: 0,
    });
  }
  const exitIdea = (symbol: string) => {
    const traceId = generateTraceId(symbol);
    return {
      traceId, symbol, side: 'SELL', confidence: 0.95, currentPrice: PRICE,
      reasoning: '[Risk Exit] EXIT_CODE=HARD_STOP Hard stop hit (-8.00%, threshold -5%). SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY',
      agent: 'PortfolioManager', origin: 'PORTFOLIO_EXIT',
      protectiveExitSeal: mintProtectiveExitSeal({ traceId, symbol, mintedBy: PROTECTIVE_EXIT_AUTHORIZED_MINTER }),
    };
  };
  const tradeFor = async (traceId: string) => (await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId)))[0];
  const fillsOf = async (orderId: string) => await db.select().from(schema.fills).where(eq(schema.fills.orderId, orderId));
  const sellTradesFor = async (symbol: string) => (await db.select().from(schema.trades).where(eq(schema.trades.symbol, symbol))).filter((t: any) => t.side === 'SELL');
  const diagnose = async (traceId: string) => {
    const a = (await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId)))[0];
    const t = await tradeFor(traceId);
    const g = (await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId))).filter((x: any) => !x.passed);
    return `assessment=${JSON.stringify(a)} trade=${JSON.stringify(t)} failedGates=${JSON.stringify(g.map((x: any) => [x.gateName, x.detail]))}`;
  };
  const ensureEnabled = async () => { await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'e2e fault case reset', actor: 'test' }); };

  async function runExit(spec: FaultSpec[], qty = 10) {
    const symbol = nextSymbol();
    await ensureEnabled();
    await carryPosition(symbol, qty);
    faults = installBrokerFaults(broker(), spec);
    const idea = exitIdea(symbol);
    await chiefTrader.reviewIdea(idea);
    await new Promise((r) => setTimeout(r, 1500));
    // surface WHY nothing reached the broker (kept in the failure message of the first wait that times out)
    (globalThis as any).__faultDiag = await diagnose(idea.traceId);
    return { symbol, idea, qty };
  }

  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_broker_faults_e2e_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.LIVE_ARM; delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ chiefTrader } = await import('../services/ChiefTraderAgent'));
    await import('../services/RiskAgent');
    ({ oms } = await import('../services/OrderManagement'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));
    ({ mintProtectiveExitSeal, PROTECTIVE_EXIT_AUTHORIZED_MINTER } = await import('../core/protectiveExitSeal'));
    ({ generateTraceId } = await import('../core/traceId'));
    await db.insert(schema.settings).values({ tradingMode: 'Paper', autoBotEnabled: true, budget: 20000, maxTradeSize: 1000, maxOrdersPerMinute: 100 });
    tradingEngine.state.enabled = true;
    await BrokerManager.getInstance().initialize();
    delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY; // dotenv re-injects them on first import; market_hours must see no clock
    expect(await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 })).toBe(true);
    oms.start(); // the real periodic follow-up / crash-recovery workers (a partial or stale report is completed by them, exactly as in production)
    ticker = setInterval(() => {
      for (const s of SYMBOLS) { marketDataWorker.cacheObservedQuote(s, PRICE); BrokerManager.getInstance().tick({ [s]: PRICE }); }
    }, 100);
  });
  afterEach(() => { faults?.uninstall(); faults = null; });
  afterAll(() => {
    try { oms.stop(); } catch { /* stopped */ }
    if (ticker) clearInterval(ticker);
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });

  it('DELAYED_FILL: the broker acknowledges first and fills later; OMS records exactly one FILLED order, one fill, flat position, one broker order', async () => {
    const { symbol, idea, qty } = await runExit([{ filter: { symbol: undefined, side: 'SELL' }, behavior: { kind: 'DELAYED_FILL', polls: 2 } }]);
    await waitFor(async () => (await tradeFor(idea.traceId))?.status === 'FILLED', 45000, 'delayed fill recorded');
    const t = await tradeFor(idea.traceId);
    const f = await fillsOf(t.id);
    expect(f.reduce((s: number, x: any) => s + x.quantity, 0)).toBe(qty);
    expect(await brokerQty(symbol)).toBe(0);
    expect((await sellTradesFor(symbol)).length).toBe(1);
    // the fault layer is installed after the carried BUY, so exactly ONE underlying placement exists: the delayed SELL
    expect(faults!.underlyingPlaceCount()).toBe(1);
  }, 120000);

  it('PARTIAL_THEN_FILL: a partial fill is recorded as a partial, the remainder completes it; fills sum to the order, no extra order', async () => {
    const { symbol, idea, qty } = await runExit([{ filter: { side: 'SELL' }, behavior: { kind: 'PARTIAL_THEN_FILL', firstQty: 4, polls: 3 } }]);
    await waitFor(async () => (await tradeFor(idea.traceId))?.status === 'FILLED', 60000, 'partial then full fill recorded');
    const t = await tradeFor(idea.traceId);
    const f = await fillsOf(t.id);
    expect(f.reduce((s: number, x: any) => s + x.quantity, 0)).toBe(qty);
    expect(f.length).toBeGreaterThanOrEqual(2);              // the partial is its own fill row
    expect(await brokerQty(symbol)).toBe(0);
    expect((await sellTradesFor(symbol)).length).toBe(1);
  }, 120000);

  it('REJECT: the order is REJECTED, the position is untouched and no fill exists', async () => {
    const { symbol, idea, qty } = await runExit([{ filter: { side: 'SELL' }, behavior: { kind: 'REJECT' } }]);
    await waitFor(async () => ['REJECTED', 'CANCELED'].includes((await tradeFor(idea.traceId))?.status), 45000, 'rejection recorded');
    const t = await tradeFor(idea.traceId);
    expect(await fillsOf(t.id)).toHaveLength(0);
    expect(await brokerQty(symbol)).toBe(qty);
  }, 120000);

  it('UNKNOWN_AFTER_SUBMIT (broker really executed): OMS keeps the row PENDING (never FILLED/REJECTED by guess), places NO second order, and reconciliation by clientOrderId resolves it to exactly one fill', async () => {
    const { symbol, idea, qty } = await runExit([{ filter: { side: 'SELL' }, behavior: { kind: 'UNKNOWN_AFTER_SUBMIT', executeUnderlying: true } }]);
    await waitFor(async () => !!(await tradeFor(idea.traceId)), 45000, 'trade row exists');
    const before = await tradeFor(idea.traceId);
    expect(before.status).toBe('PENDING');                    // outcome unknown is not a fill and not a rejection
    expect(await fillsOf(before.id)).toHaveLength(0);
    const placedBefore = faults!.underlyingPlaceCount();
    await oms.reconcileStaleOrders();
    await waitFor(async () => (await tradeFor(idea.traceId))?.status === 'FILLED', 45000, 'reconciled to FILLED by clientOrderId');
    const after = await tradeFor(idea.traceId);
    const f = await fillsOf(after.id);
    expect(f.reduce((s: number, x: any) => s + x.quantity, 0)).toBe(qty);
    expect(f).toHaveLength(1);
    expect(faults!.underlyingPlaceCount()).toBe(placedBefore);  // reconciliation never re-submits
    expect(await brokerQty(symbol)).toBe(0);
    expect((await sellTradesFor(symbol)).length).toBe(1);
  }, 180000);

  it('UNKNOWN_AFTER_SUBMIT (broker never accepted it): after reconciliation the row is not FILLED, the position is intact, and still no second order was placed', async () => {
    const { symbol, idea, qty } = await runExit([{ filter: { side: 'SELL' }, behavior: { kind: 'UNKNOWN_AFTER_SUBMIT', executeUnderlying: false } }]);
    await waitFor(async () => !!(await tradeFor(idea.traceId)), 45000, 'trade row exists');
    expect((await tradeFor(idea.traceId)).status).toBe('PENDING');
    const placedBefore = faults!.underlyingPlaceCount();
    await oms.reconcileStaleOrders();
    await new Promise((r) => setTimeout(r, 500));
    const after = await tradeFor(idea.traceId);
    expect(after.status).not.toBe('FILLED');
    expect(await fillsOf(after.id)).toHaveLength(0);
    expect(faults!.underlyingPlaceCount()).toBe(placedBefore);
    expect(await brokerQty(symbol)).toBe(qty);                 // broker truth: the position is still there
  }, 180000);

  it('DUPLICATE_EVENT and STALE_REGRESSION: a duplicated or out-of-order broker report never creates a second fill or reverts a FILLED order', async () => {
    for (const kind of ['DUPLICATE_EVENT', 'STALE_REGRESSION'] as const) {
      const { symbol, idea, qty } = await runExit([{ filter: { side: 'SELL' }, behavior: { kind } }]);
      await waitFor(async () => (await tradeFor(idea.traceId))?.status === 'FILLED', 45000, `${kind}: filled`);
      await oms.followUpOpenOrders();
      await oms.reconcileStaleOrders();
      const t = await tradeFor(idea.traceId);
      const f = await fillsOf(t.id);
      expect(t.status, kind).toBe('FILLED');
      expect(f.reduce((s: number, x: any) => s + x.quantity, 0), kind).toBe(qty);
      expect(await brokerQty(symbol), kind).toBe(0);
      expect((await sellTradesFor(symbol)).length, kind).toBe(1);
      faults?.uninstall(); faults = null;
    }
  }, 240000);
});
