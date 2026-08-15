import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EVENTS } from '../core/eventNames';

/**
 * E2A regression test (BACKTEST_QUANT_HARDENING_ANALYSIS.md): proves PortfolioMonitorWorker
 * actually reads settings.takeProfitPct/trailingStopPct instead of the previously-hardcoded,
 * unrelated +5%/-3% literals - and that a custom settings row produces a matching custom
 * threshold, the same field BacktestEngine.run()'s own exit logic now reads (see
 * BacktestEngine.test.ts's sibling "settings-driven exit thresholds" describe block). Real
 * isolated temp SQLite DB, matching this codebase's established integration-test pattern.
 */
describe('PortfolioMonitorWorker.reviewPortfolio - settings-driven exit thresholds (E2A)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioMonitor: any;
  let marketDataWorker: any;
  let eventBus: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_portfoliomonitor_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ portfolioMonitor } = await import('./PortfolioMonitor'));
    ({ marketDataWorker } = await import('./MarketDataWorker'));
    ({ eventBus } = await import('../core/EventBus'));

    // Custom, non-default thresholds - matches the sibling BacktestEngine test's values so both
    // consumers' behavior can be compared against the same real settings row shape.
    await db.insert(schema.settings).values({ takeProfitPct: 25, trailingStopPct: 8 });
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function seedHolding(symbol: string, quantity: number, averagePrice: number) {
    await db.insert(schema.portfolio).values({
      symbol, quantity, averagePrice, lastUpdated: new Date().toISOString(),
    });
  }

  it('does NOT exit at the old hardcoded -3%/+5% when settings say -8%/+25%', async () => {
    await seedHolding('DOWN4', 10, 100);
    await seedHolding('UP10', 10, 100);

    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => {
      if (symbol === 'DOWN4') return 96; // -4% - inside the new -8% stop, outside the old -3%
      if (symbol === 'UP10') return 110; // +10% - inside the new +25% target, outside the old +5%
      return null;
    });
    const emitSpy = vi.spyOn(eventBus, 'emitTradeIdea').mockImplementation(() => {});

    await portfolioMonitor.reviewPortfolio();

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('emits POSITION_MONITORED for each live-priced holding independently of a new entry idea', async () => {
    await seedHolding('WATCH1', 5, 100);
    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => symbol === 'WATCH1' ? 97 : null);
    const emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});

    await portfolioMonitor.reviewPortfolio();

    const monitored = emitSpy.mock.calls.filter((c: any) => c[0] === EVENTS.POSITION_MONITORED);
    const watch = monitored.find((c: any) => c[1]?.symbol === 'WATCH1') as [string, { pnlPct: number }] | undefined;
    expect(watch).toBeTruthy();
    expect(watch![1].pnlPct).toBeCloseTo(-3, 5);
  });

  it('DOES exit once price crosses the new -8%/+25% settings-driven thresholds', async () => {
    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => {
      if (symbol === 'DOWN4') return 91; // -9% - past the new -8% stop
      if (symbol === 'UP10') return 126; // +26% - past the new +25% target
      return null;
    });
    const emitSpy = vi.spyOn(eventBus, 'emitTradeIdea').mockImplementation(() => {});

    await portfolioMonitor.reviewPortfolio();

    expect(emitSpy).toHaveBeenCalledTimes(2);
    const reasonsBySymbol = Object.fromEntries(emitSpy.mock.calls.map((c: any) => [c[0].symbol, c[0].reasoning]));
    expect(reasonsBySymbol.DOWN4).toContain('-8%');
    expect(reasonsBySymbol.UP10).toContain('+25%');
  });
});

/**
 * Phase 16B (ARGUS_PHASE16_READINESS_REPORT.md) - the live half of closing
 * LIVE_BACKTEST_PARITY_SPEC.md's "quant strategy exit" gap (user-confirmed direction: live exits
 * become strategy-aware, matching what runStrategyBacktest() already simulates). A
 * QuantEngine-originated position's own real stop/target - captured on the opening `trades` row
 * at the exact decision moment - must override the generic settings.takeProfitPct/
 * trailingStopPct thresholds entirely, not blend with them.
 */
describe('PortfolioMonitorWorker.reviewPortfolio - quant strategy-aware exits (Phase 16B)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioMonitor: any;
  let marketDataWorker: any;
  let eventBus: any;
  let historicalDataGateway: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_portfoliomonitor_quant_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    // The first describe block in this file already imported (and, in its own afterAll, closed)
    // `../db` bound to a different temp DB - module resolution caches that import, so without
    // resetting it this describe block would reuse the first block's now-closed connection.
    vi.resetModules();
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ portfolioMonitor } = await import('./PortfolioMonitor'));
    ({ marketDataWorker } = await import('./MarketDataWorker'));
    ({ eventBus } = await import('../core/EventBus'));
    ({ historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway'));

    // Generic thresholds deliberately wide (would NOT fire on their own at the test prices below)
    // so a firing exit in these tests can only be explained by the strategy-specific levels.
    await db.insert(schema.settings).values({ takeProfitPct: 50, trailingStopPct: 50 });
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  // vi.spyOn on an already-spied property reuses the same underlying mock and its accumulated
  // call history - each test below re-spies both marketDataWorker.getLatestPrice and
  // eventBus.emitTradeIdea, so without an explicit reset a later test's assertions would see
  // earlier tests' calls (the earlier-seeded QSTOP/QTARGET holdings never leave the portfolio
  // table, so every later reviewPortfolio() call still iterates them).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedHolding(symbol: string, quantity: number, averagePrice: number) {
    await db.insert(schema.portfolio).values({
      symbol, quantity, averagePrice, lastUpdated: new Date().toISOString(),
    });
  }

  async function seedOpeningTrade(symbol: string, price: number, opts: { quantStrategyId?: string; quantStopPrice?: number; quantTargetPrice?: number; quantInvalidationJson?: string }) {
    await db.insert(schema.trades).values({
      id: `trd-${symbol}-${Date.now()}-${Math.random()}`,
      symbol, side: 'BUY', quantity: 10, price, status: 'FILLED',
      timestamp: new Date().toISOString(), filledAt: new Date().toISOString(),
      quantStrategyId: opts.quantStrategyId ?? null,
      quantStopPrice: opts.quantStopPrice ?? null,
      quantTargetPrice: opts.quantTargetPrice ?? null,
      quantInvalidationJson: opts.quantInvalidationJson ?? null,
    } as any);
  }

  it('exits at the strategy own stop even though price is well inside the generic -50% threshold', async () => {
    await seedHolding('QSTOP', 10, 100);
    await seedOpeningTrade('QSTOP', 100, { quantStrategyId: 'TREND_FOLLOWING', quantStopPrice: 95, quantTargetPrice: 130 });

    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => symbol === 'QSTOP' ? 94 : null); // -6%, would NOT trip the generic -50% stop
    const emitSpy = vi.spyOn(eventBus, 'emitTradeIdea').mockImplementation(() => {});

    await portfolioMonitor.reviewPortfolio();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect((emitSpy.mock.calls[0][0] as any).reasoning).toContain('TREND_FOLLOWING');
    expect((emitSpy.mock.calls[0][0] as any).reasoning).toContain('stop hit');
  });

  it('exits at the strategy own target even though price is well inside the generic +50% threshold', async () => {
    await seedHolding('QTARGET', 10, 100);
    await seedOpeningTrade('QTARGET', 100, { quantStrategyId: 'MOMENTUM_BREAKOUT', quantStopPrice: 90, quantTargetPrice: 112 });

    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => symbol === 'QTARGET' ? 113 : null); // +13%, would NOT trip the generic +50% target
    const emitSpy = vi.spyOn(eventBus, 'emitTradeIdea').mockImplementation(() => {});

    await portfolioMonitor.reviewPortfolio();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect((emitSpy.mock.calls[0][0] as any).reasoning).toContain('MOMENTUM_BREAKOUT');
    expect((emitSpy.mock.calls[0][0] as any).reasoning).toContain('target reached');
  });

  it('does NOT exit while price sits between the strategy own stop and target', async () => {
    await seedHolding('QHOLD', 10, 100);
    await seedOpeningTrade('QHOLD', 100, { quantStrategyId: 'PULLBACK_CONTINUATION', quantStopPrice: 90, quantTargetPrice: 120 });

    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => symbol === 'QHOLD' ? 105 : null);
    const emitSpy = vi.spyOn(eventBus, 'emitTradeIdea').mockImplementation(() => {});

    await portfolioMonitor.reviewPortfolio();

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('falls back to the generic settings-driven exit for a non-QuantEngine-sourced position (no stop/target on the opening trade)', async () => {
    await seedHolding('PLAIN', 10, 100);
    await seedOpeningTrade('PLAIN', 100, {}); // TechnicalAgent/News/Fundamental-style trade - no quant fields

    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => symbol === 'PLAIN' ? 200 : null); // +100% - past the generic +50% target
    const emitSpy = vi.spyOn(eventBus, 'emitTradeIdea').mockImplementation(() => {});

    await portfolioMonitor.reviewPortfolio();

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect((emitSpy.mock.calls[0][0] as any).reasoning).toContain('+50%');
  });

  it('exits when the original quant thesis is invalidated even though price is still between stop and target', async () => {
    await seedHolding('QINV', 10, 100);
    await seedOpeningTrade('QINV', 100, {
      quantStrategyId: 'RANGE_REVERSION',
      quantStopPrice: 50,
      quantTargetPrice: 200,
      quantInvalidationJson: JSON.stringify({
        texts: ['A real close beyond the support boundary confirms the range is breaking, not holding.'],
        strategy: 'RANGE_REVERSION',
        side: 'BUY',
        entryRegime: 'SIDEWAYS_RANGE',
        applicableRegimes: ['SIDEWAYS_RANGE'],
        structuralLevel: 100,
      }),
    });

    const bars = Array.from({ length: 60 }, (_, i) => ({
      timestamp: Date.now() - (60 - i) * 86400000,
      open: 90, high: 91, low: 89, close: 90, volume: 1000,
    }));
    vi.spyOn(historicalDataGateway, 'getBars').mockResolvedValue(bars);
    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => symbol === 'QINV' ? 90 : null);
    const emitSpy = vi.spyOn(eventBus, 'emitTradeIdea').mockImplementation(() => {});

    await portfolioMonitor.reviewPortfolio();

    expect(emitSpy).toHaveBeenCalled();
    const invCall = emitSpy.mock.calls.find((c: any) => c[0].symbol === 'QINV');
    expect(invCall).toBeDefined();
    expect((invCall![0] as any).reasoning).toMatch(/thesis invalidated/i);
  });
});
