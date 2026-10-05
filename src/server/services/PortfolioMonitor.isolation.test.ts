import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EVENTS } from '../core/eventNames';

/**
 * 2026-10-04 (per-holding exception isolation): a single outer try/catch used to wrap the
 * whole holdings loop, so one holding's failure (e.g. resolveOpeningTradeForLiveExit()
 * throwing on a corrupt row) skipped stop/target review for every holding after it.
 * Each holding now gets its own try/catch - a throwing holding is logged and skipped,
 * the rest are reviewed normally.
 */
describe('PortfolioMonitorWorker.reviewPortfolio - per-holding exception isolation (2026-10-04)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioMonitor: any;
  let marketDataWorker: any;
  let eventBus: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_pm_isolation_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ portfolioMonitor } = await import('./PortfolioMonitor'));
    ({ marketDataWorker } = await import('./MarketDataWorker'));
    ({ eventBus } = await import('../core/EventBus'));
    await db.insert(schema.settings).values({ takeProfitPct: 25, trailingStopPct: 8 });
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('reviews later holdings when an earlier holding throws', async () => {
    await db.insert(schema.portfolio).values({ symbol: 'AAA_THROWER', quantity: 10, averagePrice: 100, lastUpdated: new Date().toISOString() });
    await db.insert(schema.portfolio).values({ symbol: 'ZZZ_HEALTHY', quantity: 10, averagePrice: 100, lastUpdated: new Date().toISOString() });
    vi.spyOn(marketDataWorker, 'getLatestPrice').mockImplementation((symbol: string) => {
      if (symbol === 'AAA_THROWER') throw new Error('simulated corrupt holding data');
      if (symbol === 'ZZZ_HEALTHY') return 101; // +1% - healthy, no exit
      return null;
    });
    // 2026-10-05 P1: exits require a fresh mark — mock a fresh timestamp for the healthy holding.
    vi.spyOn(marketDataWorker, 'getLatestPriceAgeMs').mockReturnValue(1_000);
    const emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(() => {});

    await portfolioMonitor.reviewPortfolio();

    // The healthy holding was still reviewed despite the earlier holding throwing.
    const monitored = emitSpy.mock.calls.filter((c: any) => c[0] === EVENTS.POSITION_MONITORED);
    const healthy = monitored.find((c: any) => c[1]?.symbol === 'ZZZ_HEALTHY');
    expect(healthy).toBeTruthy();
    expect((healthy as any)[1].pnlPct).toBeCloseTo(1, 5);
  });
});
