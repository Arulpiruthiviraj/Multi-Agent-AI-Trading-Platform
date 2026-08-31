import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 16F (ARGUS_PHASE16_READINESS_REPORT.md) - real coverage for the live per-strategy win-rate
 * estimator that feeds QuantSignalAgent's new EV gate. Real isolated temp SQLite DB, real trade
 * rows (no mocking of the query layer) - proves the real BUY-to-SELL matching heuristic (most
 * recent prior FILLED BUY for the same symbol) against a real, hand-constructed trade history.
 */
describe('computeLiveStrategyWinRate', { timeout: 60000 }, () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let computeLiveStrategyWinRate: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_livestrategyperf_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ computeLiveStrategyWinRate } = await import('./LiveStrategyPerformance'));
  }, 60_000);

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  let seq = 0;
  async function seedBuy(symbol: string, strategyId: string, filledAt: string) {
    seq++;
    await db.insert(schema.trades).values({
      id: `buy-${seq}`, symbol, side: 'BUY', quantity: 10, price: 100, status: 'FILLED',
      timestamp: filledAt, filledAt, quantStrategyId: strategyId, quantStopPrice: 95, quantTargetPrice: 110,
    } as any);
  }
  async function seedSell(symbol: string, filledAt: string, profitLoss: number) {
    seq++;
    await db.insert(schema.trades).values({
      id: `sell-${seq}`, symbol, side: 'SELL', quantity: 10, price: 100, status: 'FILLED',
      timestamp: filledAt, filledAt, profitLoss,
    } as any);
  }

  it('returns null (never a fabricated rate) when zero real closed trades exist for a strategy', async () => {
    const result = await computeLiveStrategyWinRate('NEVER_TRADED_STRATEGY');
    expect(result).toBeNull();
  });

  it('computes a real win rate from real matched BUY->SELL pairs for one strategy', async () => {
    await seedBuy('WINSYM', 'TREND_FOLLOWING', '2026-01-01T10:00:00Z');
    await seedSell('WINSYM', '2026-01-02T10:00:00Z', 50); // win

    await seedBuy('WINSYM', 'TREND_FOLLOWING', '2026-01-03T10:00:00Z');
    await seedSell('WINSYM', '2026-01-04T10:00:00Z', -20); // loss

    await seedBuy('WINSYM', 'TREND_FOLLOWING', '2026-01-05T10:00:00Z');
    await seedSell('WINSYM', '2026-01-06T10:00:00Z', 30); // win

    const result = await computeLiveStrategyWinRate('TREND_FOLLOWING');
    expect(result).not.toBeNull();
    expect(result.sampleSize).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(1);
    expect(result.winProbability).toBeCloseTo(2 / 3, 5);
  });

  it('does not attribute a closed trade to a different strategy that opened a later position in the same symbol', async () => {
    await seedBuy('MULTISYM', 'MOMENTUM_BREAKOUT', '2026-02-01T10:00:00Z');
    await seedSell('MULTISYM', '2026-02-02T10:00:00Z', 10); // belongs to MOMENTUM_BREAKOUT

    await seedBuy('MULTISYM', 'MEAN_REVERSION', '2026-02-03T10:00:00Z');
    await seedSell('MULTISYM', '2026-02-04T10:00:00Z', -10); // belongs to MEAN_REVERSION

    const momentum = await computeLiveStrategyWinRate('MOMENTUM_BREAKOUT');
    const meanReversion = await computeLiveStrategyWinRate('MEAN_REVERSION');

    expect(momentum!.sampleSize).toBe(1);
    expect(momentum!.wins).toBe(1);
    expect(meanReversion!.sampleSize).toBe(1);
    expect(meanReversion!.losses).toBe(1);
  });

  it('ignores a closing SELL whose opening BUY carries no quantStrategyId (non-QuantEngine-sourced trade)', async () => {
    seq++;
    await db.insert(schema.trades).values({
      id: `buy-plain-${seq}`, symbol: 'PLAINSYM', side: 'BUY', quantity: 10, price: 100, status: 'FILLED',
      timestamp: '2026-03-01T10:00:00Z', filledAt: '2026-03-01T10:00:00Z',
    } as any);
    await seedSell('PLAINSYM', '2026-03-02T10:00:00Z', 999);

    const result = await computeLiveStrategyWinRate('TREND_FOLLOWING');
    // The huge PLAINSYM win must not leak into any strategy's count - it has no quantStrategyId.
    expect(result!.sampleSize).toBe(3); // unchanged from the earlier WINSYM seeding
  });

  it('excludes REPLAY-tagged closed trades entirely, even with a huge sample size and a real quantStrategyId - real bug fixed (Phase 10, 2026-08-31): this function previously had no execution_environment filter at all, unlike ReflectionEngine.ts/PortfolioMonitor.ts use of the exact same table for the exact same question. Live DB confirmed 62 REPLAY MOMENTUM_BREAKOUT round-trips existed with zero filtering.', async () => {
    for (let i = 0; i < 25; i++) {
      const buyTs = `2026-04-01T${String(i).padStart(2, '0')}:00:00Z`;
      const sellTs = `2026-04-01T${String(i).padStart(2, '0')}:30:00Z`;
      seq++;
      await db.insert(schema.trades).values({
        id: `replay-buy-${seq}`, symbol: 'REPLAYSYM', side: 'BUY', quantity: 10, price: 100, status: 'FILLED',
        timestamp: buyTs, filledAt: buyTs, quantStrategyId: 'MOMENTUM_BREAKOUT', executionEnvironment: 'REPLAY',
      } as any);
      seq++;
      await db.insert(schema.trades).values({
        id: `replay-sell-${seq}`, symbol: 'REPLAYSYM', side: 'SELL', quantity: 10, price: 100, status: 'FILLED',
        timestamp: sellTs, filledAt: sellTs, profitLoss: 50, executionEnvironment: 'REPLAY',
      } as any);
    }

    const result = await computeLiveStrategyWinRate('MOMENTUM_BREAKOUT');
    // Only the ONE real, organic MOMENTUM_BREAKOUT round-trip seeded earlier (MULTISYM, in the
    // "does not attribute a closed trade to a different strategy" test above) should count - the
    // 25 REPLAY round-trips seeded just now (well above MIN_SAMPLE_SIZE_FOR_KELLY on their own)
    // must not inflate this at all. Before this fix, this would have returned sampleSize=26.
    expect(result).not.toBeNull();
    expect(result!.sampleSize).toBe(1);
    expect(result!.wins).toBe(1);
  });

  it('still includes a legacy trade with a null/blank executionEnvironment (real trade, predates tagging) - never over-excludes', async () => {
    seq++;
    await db.insert(schema.trades).values({
      id: `legacy-buy-${seq}`, symbol: 'LEGACYSYM', side: 'BUY', quantity: 10, price: 100, status: 'FILLED',
      timestamp: '2026-05-01T10:00:00Z', filledAt: '2026-05-01T10:00:00Z', quantStrategyId: 'RANGE_REVERSION',
    } as any); // executionEnvironment intentionally omitted - legacy pre-tagging row
    await seedSell('LEGACYSYM', '2026-05-02T10:00:00Z', 15);

    const result = await computeLiveStrategyWinRate('RANGE_REVERSION');
    expect(result).not.toBeNull();
    expect(result!.sampleSize).toBe(1);
    expect(result!.wins).toBe(1);
  });
});
