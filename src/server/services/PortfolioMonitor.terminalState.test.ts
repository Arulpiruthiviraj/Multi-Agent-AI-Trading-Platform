import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-10-08 memory-leak hunt (subsystem: PORTFOLIO / RECONCILIATION / EXITS).
 *
 * Candidates under test — per-symbol exit/monitor state that must not survive a flat position:
 *   1. PortfolioMonitorWorker.campaignScalpTarget1Hit (Set<string>) — added when a campaign
 *      holding hits intraday ATR Target-1; previously never removed, so the "BE stop armed"
 *      flag survived position close AND across sessions (a stale flag also makes the next
 *      position in the same symbol eligible for a BE-stop exit before it ever hit Target-1).
 *   2. portfolioIntel.lastExitEmitAt (Map<string, number>) — exit-idea cooldown entry per
 *      symbol; previously never removed, so a closed symbol kept suppressing its first exit
 *      idea on a later re-entry.
 *
 * Both are pruned against the authoritative `portfolio` table at the start of every
 * reviewPortfolio() cycle: a symbol with no open holding (quantity > 0) is terminal state.
 * Cleanup only — exit math, reconciliation semantics, and position accounting are untouched.
 */
describe('PortfolioMonitor terminal-state cleanup (2026-10-08 leak hunt)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioMonitor: any;
  let marketDataWorker: any;
  let eventBus: any;
  let historicalDataGateway: any;
  let portfolioIntel: any;
  const prices = new Map<string, number>();

  const heapMB = (): number => {
    (global as any).gc?.();
    return process.memoryUsage().heapUsed / 1048576;
  };

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_pm_terminal_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ARGUS_PORTFOLIO_INTEL_ENABLED = 'true';
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    portfolioIntel = await import('../continuous/portfolioIntel');
    ({ portfolioMonitor } = await import('./PortfolioMonitor'));
    ({ marketDataWorker } = await import('./MarketDataWorker'));
    ({ eventBus } = await import('../core/EventBus'));
    ({ historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway'));

    await db.insert(schema.settings).values({
      takeProfitPct: 25,
      trailingStopPct: 8,
      campaignEnabled: true,
      closePositionsBeforeMarketClose: false,
    });
  });

  beforeEach(() => {
    vi.spyOn(eventBus, 'emit').mockImplementation(() => {});
    // Flat bars: TR = 2 every bar -> ATR(14) = 2 -> Target-1 = 100 + 1.25 * 2 = 102.50.
    const mkBars = () => {
      const bars: any[] = [];
      const now = Date.now();
      for (let i = 120; i >= 1; i--) {
        bars.push({ timestamp: now - i * 300000, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
      }
      return bars;
    };
    vi.spyOn(historicalDataGateway, 'ensureBars').mockResolvedValue(undefined as any);
    vi.spyOn(historicalDataGateway, 'getBars').mockImplementation(async () => mkBars());
    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => prices.get(symbol) ?? null);
    vi.spyOn(marketDataWorker, 'getLatestPriceAgeMs').mockReturnValue(1000);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.ARGUS_PORTFOLIO_INTEL_ENABLED;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  const openPosition = async (symbol: string) => {
    await db.insert(schema.portfolio).values({
      symbol, quantity: 10, averagePrice: 100, lastUpdated: new Date().toISOString(),
    });
    await db.insert(schema.trades).values({
      id: `trade-${symbol}-${Date.now()}`, symbol, side: 'BUY', quantity: 10, price: 100,
      status: 'FILLED', timestamp: new Date().toISOString(),
      filledAt: new Date().toISOString(), executionEnvironment: 'PAPER',
    });
    prices.set(symbol, 103); // >= 102.50 Target-1 -> arms BE stop + emits one exit idea
  };

  /** Mirrors applyPositionFill()'s flat path: a fully closed position's row is DELETEd. */
  const closePosition = async (symbol: string) => {
    sqliteDb.prepare('DELETE FROM portfolio WHERE symbol = ?').run(symbol);
    prices.delete(symbol);
  };

  const trackedTarget1 = (): Set<string> => (portfolioMonitor as any).campaignScalpTarget1Hit as Set<string>;

  it('drops campaign Target-1 flags for symbols that are no longer held', async () => {
    const heapBefore = heapMB();
    const N = 40;
    for (let i = 0; i < N; i++) {
      const symbol = `TLT1_${i}`;
      await openPosition(symbol);
      await portfolioMonitor.reviewPortfolio();
      expect(trackedTarget1().has(symbol)).toBe(true); // write path exercised
      await closePosition(symbol);
    }
    const heapAfterCycles = heapMB();
    await portfolioMonitor.reviewPortfolio(); // empty book: prune pass runs
    const heapAfterPrune = heapMB();

    expect(trackedTarget1().size).toBe(0);
    console.log(
      `[leak-hunt] campaignScalpTarget1Hit: heap ${heapBefore.toFixed(1)} -> ${heapAfterCycles.toFixed(1)} -> ${heapAfterPrune.toFixed(1)} MB over ${N} open/close cycles; set size after close = ${trackedTarget1().size}`,
    );
  });

  it('drops exit-idea cooldown entries for symbols that are no longer held', async () => {
    const symbol = 'TLCD_0';
    await openPosition(symbol);
    await portfolioMonitor.reviewPortfolio();
    // Exit idea was emitted this cycle -> cooldown entry exists -> suppressed now.
    expect(portfolioIntel.canEmitPortfolioExitIdea(symbol)).toBe(false);
    await closePosition(symbol);
    await portfolioMonitor.reviewPortfolio();
    // Terminal state cleaned: a later position in the same symbol is not throttled by the old one.
    expect(portfolioIntel.canEmitPortfolioExitIdea(symbol)).toBe(true);
  });

  it('keeps Target-1 flags and cooldowns for symbols that are still held (no over-prune)', async () => {
    const symbol = 'TLKEEP_0';
    await openPosition(symbol);
    await portfolioMonitor.reviewPortfolio();
    expect(trackedTarget1().has(symbol)).toBe(true);
    expect(portfolioIntel.canEmitPortfolioExitIdea(symbol)).toBe(false);
    // Second review with the position still open: state must survive.
    await portfolioMonitor.reviewPortfolio();
    expect(trackedTarget1().has(symbol)).toBe(true);
    expect(portfolioIntel.canEmitPortfolioExitIdea(symbol)).toBe(false);
    await closePosition(symbol);
    await portfolioMonitor.reviewPortfolio();
    expect(trackedTarget1().has(symbol)).toBe(false);
    expect(portfolioIntel.canEmitPortfolioExitIdea(symbol)).toBe(true);
  });
});
