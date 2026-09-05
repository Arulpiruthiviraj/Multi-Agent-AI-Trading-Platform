import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trades, fills, portfolio } from '../db/schema';
import { structuredLogger } from '../observability/StructuredLogger';

// Phase 3 changed OMS from a single insert to insert-then-update as the order progresses
// (PENDING at submission -> broker acceptance -> terminal fill/reject), so the mock now tracks
// a mutable "current row" that both insert and update write into, plus separate insert logs for
// `trades` vs `fills` so assertions can tell real order-lifecycle inserts apart from fill records.
const {
  mockDb, setExistingTrades, setThrowOnIdempotency, setEnvRow, setPortfolioRows,
  tradesInserts, fillsInserts, getFinalTradeRow, getPortfolioRows,
} = vi.hoisted(() => {
  const tradesInserts: any[] = [];
  const fillsInserts: any[] = [];
  let existingTrades: any[] = [];
  let portfolioRows: any[] = [];
  let currentRow: any = null;
  let throwOnIdempotency = false;
  let envRow: any = { tradingMode: 'Paper', paperMode: true };

  const selectBuilder: any = {
    _table: null as any,
    from(table: any) { selectBuilder._table = table; return selectBuilder; },
    where() { return selectBuilder; },
    orderBy() { return selectBuilder; },
    limit() { return selectBuilder; },
    get() { return envRow; },
    then(resolve: any, reject: any) {
      if (throwOnIdempotency) return Promise.reject(new Error('idempotency lookup failed')).then(resolve, reject);
      if (selectBuilder._table === portfolio) return Promise.resolve(portfolioRows).then(resolve, reject);
      return Promise.resolve(existingTrades).then(resolve, reject);
    },
  };
  const mockDb = {
    select: () => {
      selectBuilder._table = null;
      return selectBuilder;
    },
    insert: (table: any) => ({
      values: (v: any) => {
        if (table === trades) { tradesInserts.push(v); currentRow = { ...v }; }
        else if (table === fills) { fillsInserts.push(v); }
        return Promise.resolve({});
      },
    }),
    update: (table?: any) => ({
      set(patch: any) {
        if (table === portfolio) {
          if (portfolioRows[0]) Object.assign(portfolioRows[0], patch);
        } else if (currentRow) {
          Object.assign(currentRow, patch);
        }
        return this;
      },
      where() { return Promise.resolve({}); },
    }),
    delete: (table?: any) => ({
      where() {
        if (table === portfolio) portfolioRows.length = 0;
        return Promise.resolve({});
      },
    }),
  };
  return {
    mockDb, tradesInserts, fillsInserts,
    setExistingTrades: (rows: any[]) => { existingTrades = rows; },
    setPortfolioRows: (rows: any[]) => { portfolioRows = rows; },
    getPortfolioRows: () => portfolioRows,
    setThrowOnIdempotency: (v: boolean) => { throwOnIdempotency = v; },
    setEnvRow: (row: any) => { envRow = row; },
    getFinalTradeRow: () => currentRow,
  };
});

const { emitOrderExecution } = vi.hoisted(() => ({ emitOrderExecution: vi.fn() }));

const { mockBrokerHolder } = vi.hoisted(() => ({ mockBrokerHolder: { broker: null as any } }));
const { setTradingState } = vi.hoisted(() => ({ setTradingState: vi.fn(async () => {}) }));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), emitOrderExecution } }));
vi.mock('../../brokers/BrokerManager', () => ({
  BrokerManager: { getInstance: () => ({ getActiveBroker: () => mockBrokerHolder.broker }) },
}));
vi.mock('../engines/TradingEngine', () => ({
  tradingEngine: { setTradingState },
}));

import { OrderManagementService } from './OrderManagement';

describe('OrderManagementService.executeOrder', () => {
  const oms = new OrderManagementService();

  beforeEach(() => {
    tradesInserts.length = 0;
    fillsInserts.length = 0;
    emitOrderExecution.mockClear();
    setTradingState.mockClear();
    setExistingTrades([]);
    setPortfolioRows([]);
    setThrowOnIdempotency(false);
    setEnvRow({ tradingMode: 'Paper', paperMode: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.EXTENDED_HOURS_EXECUTION_ENABLED;
  });

  it('refuses to place a second order for a traceId that already has one (idempotency)', async () => {
    setExistingTrades([{ id: 'already-placed' }]);
    const placeOrder = vi.fn();
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(), positions: vi.fn() };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'dup-trace');

    expect(placeOrder).not.toHaveBeenCalled();
    expect(tradesInserts.length).toBe(0);
  });

  it('aborts before placeOrder when the idempotency lookup throws', async () => {
    setThrowOnIdempotency(true);
    const placeOrder = vi.fn();
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(), positions: vi.fn() };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'lookup-fail-trace');

    expect(placeOrder).not.toHaveBeenCalled();
    expect(tradesInserts.length).toBe(0);
  });

  it('inserts a PENDING row immediately at submission, before the broker call resolves', async () => {
    let resolvePlaceOrder: (v: any) => void;
    const placeOrder = vi.fn(() => new Promise(r => { resolvePlaceOrder = r; }));
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    const resultPromise = oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'submit-trace');
    // Macrotask boundary - guarantees every already-queued microtask (the idempotency check and
    // the initial insert, both awaited before the broker call) has actually run, unlike counting
    // `await Promise.resolve()` calls which is fragile to exactly how many microtask hops each
    // mocked thenable takes to resolve.
    await new Promise(r => setTimeout(r, 0));

    expect(tradesInserts).toHaveLength(1);
    expect(tradesInserts[0].status).toBe('PENDING');
    expect(tradesInserts[0].submittedAt).toBeTruthy();

    resolvePlaceOrder!({ id: 'order-submit', status: 'FILLED', averageFillPrice: 100 });
    await resultPromise;
    expect(getFinalTradeRow().status).toBe('FILLED');
  });

  it('records intended price on the PENDING row so capital reservation is not $0', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'order-px', status: 'FILLED', averageFillPrice: 99 }));
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'price-trace', undefined, undefined, null, null, null, null, 150);
    expect(tradesInserts[0].price).toBe(150);
    expect(getFinalTradeRow().price).toBe(99);
  });

  describe('Session-Aware Trading Architecture Phase 5 (2026-09-05): extended-hours order construction', () => {
    // 2026-01-14 is a Wednesday; EST (no DST) is UTC-5, so 08:00 ET = 13:00 UTC.
    const PRE_MARKET_UTC = new Date('2026-01-14T13:00:00.000Z');

    it('extended-hours execution disabled (default): sends plain MARKET even during premarket hours - zero behavior change', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(PRE_MARKET_UTC);
      const placeOrder = vi.fn(async () => ({ id: 'order-eh-off', status: 'FILLED', averageFillPrice: 150 }));
      mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

      await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'eh-off-trace', undefined, undefined, null, null, null, null, 150);

      expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'MARKET' }));
      expect(placeOrder).not.toHaveBeenCalledWith(expect.objectContaining({ extendedHours: true }));
    });

    it('enabled + premarket + valid intendedPrice: sends a real LIMIT order with extendedHours:true', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(PRE_MARKET_UTC);
      process.env.EXTENDED_HOURS_EXECUTION_ENABLED = 'true';
      const placeOrder = vi.fn(async () => ({ id: 'order-eh-on', status: 'FILLED', averageFillPrice: 150.25 }));
      mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

      await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'eh-on-trace', undefined, undefined, null, null, null, null, 150.25);

      expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'LIMIT', price: 150.25, extendedHours: true }));
    });

    it('enabled + premarket but no intendedPrice: falls back to MARKET rather than fabricating a limit price', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(PRE_MARKET_UTC);
      process.env.EXTENDED_HOURS_EXECUTION_ENABLED = 'true';
      const placeOrder = vi.fn(async () => ({ id: 'order-eh-nopx', status: 'FILLED', averageFillPrice: 150 }));
      mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

      await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'eh-nopx-trace');

      expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'MARKET' }));
    });

    it('enabled but REGULAR session: sends plain MARKET, unaffected by the flag', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-14T15:00:00.000Z')); // 10:00 ET, REGULAR session
      process.env.EXTENDED_HOURS_EXECUTION_ENABLED = 'true';
      const placeOrder = vi.fn(async () => ({ id: 'order-eh-regular', status: 'FILLED', averageFillPrice: 150 }));
      mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

      await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'eh-regular-trace', undefined, undefined, null, null, null, null, 150);

      expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ type: 'MARKET' }));
    });
  });

  it('places a fresh order when no prior trade exists for the traceId, and records the real fill', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'order-1', status: 'FILLED', averageFillPrice: 100 }));
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'fresh-trace');

    // Phase 1 (ARGUS_SAFETY_HARDENING_REPORT.md) - clientOrderId is now always passed through as
    // the real broker-level idempotency key (the local trades.id UUID, generated fresh per order
    // attempt) - asserted loosely here (a real UUID string) rather than a specific value, since
    // the id itself is generated inside executeOrder() and not observable from this test.
    expect(placeOrder).toHaveBeenCalledWith({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10, clientOrderId: expect.any(String) });
    expect(tradesInserts).toHaveLength(1); // one order-lifecycle row, updated in place - not re-inserted
    const finalRow = getFinalTradeRow();
    expect(finalRow.status).toBe('FILLED');
    expect(finalRow.price).toBe(100);
    expect(finalRow.brokerOrderId).toBe('order-1');
    // A real fill happened - it should also land in the fills ledger.
    expect(fillsInserts).toHaveLength(1);
    expect(fillsInserts[0].price).toBe(100);
  });

  it('polls for a terminal fill when the broker initially returns PENDING, and records the real fill price', async () => {
    vi.useFakeTimers();
    const placeOrder = vi.fn(async () => ({ id: 'order-2', status: 'PENDING' }));
    const orders = vi.fn(async () => [{ id: 'order-2', status: 'FILLED', averageFillPrice: 123.45 }]);
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders, positions: vi.fn(async () => []) };

    const resultPromise = oms.executeOrder('AAPL', 'BUY', 5, 'reasoning', 'poll-trace');
    await vi.advanceTimersByTimeAsync(500);
    await resultPromise;

    const finalRow = getFinalTradeRow();
    expect(finalRow.status).toBe('FILLED');
    expect(finalRow.price).toBe(123.45);
  });

  it('records PENDING honestly (no fabricated fill) if the order never reaches a terminal state before the poll timeout', async () => {
    vi.useFakeTimers();
    const placeOrder = vi.fn(async () => ({ id: 'order-3', status: 'PENDING' }));
    const orders = vi.fn(async () => [{ id: 'order-3', status: 'PENDING' }]);
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders, positions: vi.fn(async () => []) };

    const resultPromise = oms.executeOrder('AAPL', 'BUY', 5, 'reasoning', 'timeout-trace');
    await vi.advanceTimersByTimeAsync(5000);
    await resultPromise;

    const finalRow = getFinalTradeRow();
    expect(finalRow.status).toBe('PENDING');
    expect(finalRow.price).toBe(0);
    expect(fillsInserts).toHaveLength(0); // never actually filled - no fill record fabricated
  });

  it('computes real realized P&L on a SELL fill using the pre-trade entry price', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'order-4', status: 'FILLED', averageFillPrice: 120 }));
    const positions = vi.fn(async () => [{ symbol: 'AAPL', quantity: 10, entryPrice: 100 }]);
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions };

    await oms.executeOrder('AAPL', 'SELL', 10, 'reasoning', 'sell-trace');

    expect(getFinalTradeRow().profitLoss).toBe(200); // (120 - 100) * 10
  });

  it('computes profit_loss via local portfolio fallback when broker positions() throws', async () => {
    setPortfolioRows([{ symbol: 'AAPL', quantity: 5, averagePrice: 100 }]);
    const placeOrder = vi.fn(async () => ({ id: 'order-fallback', status: 'FILLED', averageFillPrice: 110 }));
    const positions = vi.fn(async () => { throw new Error('positions unavailable'); });
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions };

    await oms.executeOrder('AAPL', 'SELL', 5, 'reasoning', 'sell-fallback-trace');

    expect(positions).toHaveBeenCalled();
    expect(getFinalTradeRow().profitLoss).toBe(50); // (110 - 100) * 5 from local averagePrice
    // Full SELL fill must clear local portfolio before the next recon tick.
    expect(getPortfolioRows().length === 0 || getPortfolioRows()[0]?.quantity === 0).toBe(true);
  });

  it('makes an unattributable P&L failure observable instead of silently leaving profit_loss null with only a console log', async () => {
    // Every entry-price fallback fails: broker positions() throws, no local portfolio row, and
    // (implicitly, via the mocked trades select returning []) no prior opening BUY is found either.
    const warnSpy = vi.spyOn(structuredLogger, 'warn');
    setPortfolioRows([]);
    const placeOrder = vi.fn(async () => ({ id: 'order-unattributable', status: 'FILLED', averageFillPrice: 110 }));
    const positions = vi.fn(async () => { throw new Error('positions unavailable'); });
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions };

    await oms.executeOrder('AAPL', 'SELL', 5, 'reasoning', 'sell-unattributable-trace');

    // Never invent a P&L figure when no entry price could be resolved.
    expect(getFinalTradeRow().profitLoss).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'pnl_attribution_failed',
      expect.objectContaining({
        category: 'SYSTEM',
        eventType: 'PNL_ATTRIBUTION_FAILED',
        reason: 'NO_ENTRY_PRICE_RESOLVED',
        symbol: 'AAPL',
      }),
    );
    warnSpy.mockRestore();
  });

  it('keeps PENDING and pauses trading when placeOrder throws (unknown submit is not REJECTED)', async () => {
    const placeOrder = vi.fn(async () => { throw new Error('broker down'); });
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'fail-trace');

    const finalRow = getFinalTradeRow();
    expect(finalRow.status).toBe('PENDING');
    expect(finalRow.price).toBe(0);
    expect(String(finalRow.reasoning)).toMatch(/submitOutcome=UNKNOWN/);
    expect(fillsInserts).toHaveLength(0);
    expect(setTradingState).toHaveBeenCalledWith('TRADING_PAUSED', expect.objectContaining({
      reason: expect.stringContaining('placeOrder threw'),
    }));
  });

  it('LIVE + LIVE_ARM + LIVE_NO_GO refuses placeOrder', async () => {
    const prev = process.env.PAPER_TRADING_ONLY;
    process.env.PAPER_TRADING_ONLY = 'false';
    setEnvRow({ tradingMode: 'LIVE', paperMode: false });
    const { armLiveTrading, disarmLiveTrading, LIVE_TRADING_CONFIRMATION_PHRASE } = await import('../core/LiveTradingConfirmation');
    armLiveTrading(LIVE_TRADING_CONFIRMATION_PHRASE);
    const placeOrder = vi.fn(async () => ({ id: 'live-1', status: 'FILLED', averageFillPrice: 1 }));
    mockBrokerHolder.broker = {
      id: 'alpaca',
      name: 'Alpaca',
      placeOrder,
      orders: vi.fn(async () => []),
      positions: vi.fn(async () => []),
      getCapabilities: () => ({ paperTrading: true, liveTrading: true }),
    };
    try {
      await oms.executeOrder('AAPL', 'BUY', 1, 'reasoning', 'live-nogo-trace');
      expect(placeOrder).not.toHaveBeenCalled();
      expect(getFinalTradeRow().status).toBe('REJECTED');
      expect(String(getFinalTradeRow().reasoning)).toMatch(/LIVE_NO_GO/);
      // Real bug found and fixed this pass: the env-gate rejection branch used to `return` before
      // ever calling emitOrderExecution(), so ORDER_EXECUTED never fired for this outcome.
      // ORDER_SUBMITTED (emitted earlier in executeOrder) had already moved the transaction to
      // EXECUTED in TransactionLifecycleTracker, and nothing ever closed it out - a rejected
      // transaction stayed EXECUTED forever. ORDER_EXECUTED is the only event that can close it.
      expect(emitOrderExecution).toHaveBeenCalledWith(expect.objectContaining({ status: 'REJECTED' }));
    } finally {
      disarmLiveTrading();
      if (prev === undefined) delete process.env.PAPER_TRADING_ONLY;
      else process.env.PAPER_TRADING_ONLY = prev;
    }
  });

  it('PAPER orders still reach the broker when live readiness is LIVE_NO_GO', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'paper-ok', status: 'FILLED', averageFillPrice: 50 }));
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };
    await oms.executeOrder('AAPL', 'BUY', 2, 'reasoning', 'paper-nogo-unaffected');
    expect(placeOrder).toHaveBeenCalled();
    expect(getFinalTradeRow().status).toBe('FILLED');
  });

  // Reproduces the real 2026-08-21T18:31 TSLA/RIOT BROKER_ENVIRONMENT_UNKNOWN rejections
  // (data/argus.db trades rows 1b8f549f.../60697e63...): an unseeded/malformed settings.tradingMode
  // (null, not the schema's 'Paper' default) with no PAPER_TRADING_ONLY enforcement and no
  // brokerConnections row for the active broker. Before the fix, OrderManagement.ts's
  // readTradingMode() returned this raw null straight through to authorizeProductionOrder(), which
  // classifyBrokerEnvironment() cannot classify as PAPER or LIVE -> UNKNOWN -> rejected, even though
  // Alpaca's own getCapabilities() says it is fully paper-capable. readTradingMode() now normalizes
  // through normalizeTradingMode() (fails closed to 'PAPER', never 'LIVE'), so this same ambiguous
  // state now correctly resolves to PAPER and the order reaches the broker.
  it('does not reject with BROKER_ENVIRONMENT_UNKNOWN when settings.tradingMode is unseeded/null (TSLA/RIOT regression)', async () => {
    const prev = process.env.PAPER_TRADING_ONLY;
    delete process.env.PAPER_TRADING_ONLY;
    setEnvRow({ tradingMode: null, paperMode: null });
    const placeOrder = vi.fn(async () => ({ id: 'tsla-1', status: 'FILLED', averageFillPrice: 250 }));
    mockBrokerHolder.broker = {
      id: 'alpaca',
      name: 'Alpaca',
      placeOrder,
      orders: vi.fn(async () => []),
      positions: vi.fn(async () => []),
      getCapabilities: () => ({ paperTrading: true, liveTrading: true }),
    };
    try {
      await oms.executeOrder('TSLA', 'BUY', 1, 'reasoning', 'tsla-regression-trace');
      expect(placeOrder).toHaveBeenCalled();
      const finalRow = getFinalTradeRow();
      expect(finalRow.status).toBe('FILLED');
      expect(String(finalRow.reasoning || '')).not.toMatch(/BROKER_ENVIRONMENT_UNKNOWN/);
    } finally {
      if (prev === undefined) delete process.env.PAPER_TRADING_ONLY;
      else process.env.PAPER_TRADING_ONLY = prev;
    }
  });
});
