import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB), same pattern as PredictionOutcomeEvaluator.test.ts:
 * seeds real ohlcv_bars rows directly so the evaluator's own point-in-time SMA50/ADX walk-forward
 * runs against real rows, not a mock.
 */
describe('TrendFollowingExitEvaluator', () => {
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let evaluateTrendFollowingExit: any;
  let tmpDbPath: string;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const ENTRY = new Date('2026-03-02T00:00:00.000Z').getTime(); // arbitrary fixed epoch

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_tf_exit_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ evaluateTrendFollowingExit } = await import('./TrendFollowingExitEvaluator'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function seedDailyBars(symbol: string, closesFromDayMinus60: number[]): Promise<void> {
    // closesFromDayMinus60[0] is 60 calendar days before ENTRY (real lookback buffer for SMA50),
    // closesFromDayMinus60[60] is the ENTRY day itself, subsequent indices are days after entry.
    const rows = closesFromDayMinus60.map((close, i) => {
      const ts = ENTRY - 60 * DAY_MS + i * DAY_MS;
      return {
        id: `${symbol}:1Day:${ts}`,
        symbol, timeframe: '1Day', timestamp: ts,
        open: close, high: close + 0.5, low: close - 0.5, close, volume: 1_000_000,
        source: 'test',
      };
    });
    for (const row of rows) await db.insert(schema.ohlcvBars).values(row);
  }

  it('returns null when there is not enough real historical data to seed SMA50', async () => {
    await seedDailyBars('THINDATA', Array.from({ length: 10 }, () => 100));
    const result = await evaluateTrendFollowingExit('THINDATA', 'BUY', ENTRY, 90 * DAY_MS);
    expect(result).toBeNull();
  });

  it('a BUY position that keeps trending up never triggers the trailing stop - STILL_OPEN, not forced WIN/LOSS', async () => {
    // Flat lookback (60 days at 100) so SMA50 is well-seeded, then steady, moderate appreciation
    // that stays comfortably above its own lagging SMA50 for the whole window.
    const lookback = Array.from({ length: 61 }, () => 100); // days -60..0 (entry)
    const uptrend = Array.from({ length: 40 }, (_, i) => 100 + i * 0.8); // days 1..40
    await seedDailyBars('STRONGTREND', [...lookback, ...uptrend]);

    const result = await evaluateTrendFollowingExit('STRONGTREND', 'BUY', ENTRY, 90 * DAY_MS);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('STILL_OPEN');
    expect(result!.exitReason).toBe('STILL_OPEN');
    expect(result!.exitPrice).toBeNull();
    expect(result!.actualReturn).toBeGreaterThan(0); // real unrealized gain, reported honestly, not hidden
  });

  it('a BUY position that reverses hard eventually crosses below its own trailing SMA50 and exits - real WIN or LOSS, not a snapshot at an arbitrary day', async () => {
    const lookback = Array.from({ length: 61 }, () => 100);
    // Rises for a while (so SMA50 climbs and the position is genuinely profitable at points),
    // then reverses hard and stays down long enough to drag the close below the (slower-moving) SMA50.
    const rise = Array.from({ length: 20 }, (_, i) => 100 + i * 1.2); // up to ~124
    const fall = Array.from({ length: 30 }, (_, i) => 124 - i * 3); // down to ~34
    await seedDailyBars('REVERSAL', [...lookback, ...rise, ...fall]);

    const result = await evaluateTrendFollowingExit('REVERSAL', 'BUY', ENTRY, 90 * DAY_MS);
    expect(result).not.toBeNull();
    expect(result!.exitReason === 'SMA50_TRAIL_STOP' || result!.exitReason === 'ADX_FADE').toBe(true);
    expect(result!.exitPrice).not.toBeNull();
    expect(result!.holdingPeriodDays).toBeGreaterThan(0);
    // Entered at 100, real strategy-relevant exit should be well below the ~124 peak, not an
    // arbitrary fixed-day snapshot - this is the whole point of the exit-aware evaluator.
    expect(result!.exitPrice!).toBeLessThan(124);
  });

  it('mirrors the exit logic correctly for a SELL (short) position', async () => {
    const lookback = Array.from({ length: 61 }, () => 100);
    // A shallow, short dip (keeps the lagging SMA50 anchored near 100) followed by a steep,
    // persistent rise - so that whichever day the close first crosses back above the still-~100
    // trailing stop, price is already meaningfully above the entry level: a genuine, unambiguous
    // stop-out for a short, not merely "gave back some of an open profit" (a deep-then-slow-rise
    // fixture can trigger the SMA cross while price is still below entry, which is a real WIN for
    // a short and was the source of an earlier, incorrect test assumption here).
    const dip = Array.from({ length: 5 }, (_, i) => 100 - (i + 1) * 1); // 99..95
    const rise = Array.from({ length: 30 }, (_, i) => 95 + (i + 1) * 5); // 100..245
    await seedDailyBars('SHORTREVERSAL', [...lookback, ...dip, ...rise]);

    const result = await evaluateTrendFollowingExit('SHORTREVERSAL', 'SELL', ENTRY, 90 * DAY_MS);
    expect(result).not.toBeNull();
    expect(result!.exitReason === 'SMA50_TRAIL_STOP' || result!.exitReason === 'ADX_FADE').toBe(true);
    // A short that gets stopped out by a rally against it is a real LOSS, not silently a WIN.
    expect(result!.outcome).toBe('LOSS');
  });

  it('uses a worse (gapped-through) exit price rather than an unrealistic exact-stop fill', async () => {
    const lookback = Array.from({ length: 61 }, () => 100);
    const rise = Array.from({ length: 20 }, (_, i) => 100 + i * 1.2);
    // A sudden, large one-day crash well past where the SMA50 sits, then flat - forces the
    // exit-day open to have already gapped through the trailing stop level.
    const crash = [124 - 40, ...Array.from({ length: 29 }, () => 124 - 40)];
    await seedDailyBars('GAPCRASH', [...lookback, ...rise, ...crash]);

    const result = await evaluateTrendFollowingExit('GAPCRASH', 'BUY', ENTRY, 90 * DAY_MS);
    expect(result).not.toBeNull();
    expect(result!.exitReason).toBe('SMA50_TRAIL_STOP');
    // The gapped price (~84) is well below where SMA50 would realistically sit after the rise -
    // proves the gap-through open, not the stop level itself, was used as the fill.
    expect(result!.exitPrice!).toBeLessThan(95);
  });

  it('ignores an intrabar wick that would have touched the stop level - only the daily CLOSE can trigger an exit (no invented intrabar precision)', async () => {
    // Same shape as the "keeps trending up" baseline, except one mid-window day gets an
    // artificially deep low (an intraday wick) while its close stays on-trend. Real daily bars
    // cannot say WHEN intrabar a level was touched relative to other prices that day - rather than
    // guessing, the evaluator deliberately only ever reads bars[i].close (see this file's own
    // header comment), so this wick must have zero effect on the outcome.
    const lookback = Array.from({ length: 61 }, () => 100);
    const uptrend = Array.from({ length: 40 }, (_, i) => 100 + i * 0.8);
    await seedDailyBars('WICKTREND', [...lookback, ...uptrend]);

    const wickDayIndex = 20; // a day well inside the uptrend, entryIdx(60) + 20
    const closes = [...lookback, ...uptrend];
    const ts = ENTRY - 60 * DAY_MS + wickDayIndex * DAY_MS;
    await db.update(schema.ohlcvBars)
      .set({ low: 1 }) // deep intraday wick far below any plausible SMA50 trail stop
      .where(eq(schema.ohlcvBars.id, `WICKTREND:1Day:${ts}`));

    const result = await evaluateTrendFollowingExit('WICKTREND', 'BUY', ENTRY, 90 * DAY_MS);
    expect(result).not.toBeNull();
    // Identical to the no-wick uptrend baseline: still open, still a real unrealized gain - the
    // wick was never seen by the close-only exit check.
    expect(result!.outcome).toBe('STILL_OPEN');
    expect(result!.exitReason).toBe('STILL_OPEN');
    expect(result!.actualReturn).toBeGreaterThan(0);
  });

  it('tolerates a real mid-window data gap (a run of missing daily bars) without crashing or fabricating a synthetic bar for the missing days', async () => {
    const lookback = Array.from({ length: 61 }, () => 100);
    const rise = Array.from({ length: 20 }, (_, i) => 100 + i * 1.2);
    const fall = Array.from({ length: 30 }, (_, i) => 124 - i * 3);
    const allCloses = [...lookback, ...rise, ...fall];
    // Drop 4 consecutive mid-window rows entirely (a real data-outage gap), rather than seeding
    // every index - HistoricalDataGateway.getBars only ever returns rows that really exist, so the
    // evaluator must walk forward over whatever timestamps are actually present, never invent a
    // bar to fill the hole.
    const gapStart = 70;
    const gapLen = 4;
    const rows = allCloses.map((close, i) => ({ i, close })).filter(({ i }) => i < gapStart || i >= gapStart + gapLen);
    for (const { i, close } of rows) {
      const ts = ENTRY - 60 * DAY_MS + i * DAY_MS;
      await db.insert(schema.ohlcvBars).values({
        id: `GAPWINDOW:1Day:${ts}`, symbol: 'GAPWINDOW', timeframe: '1Day', timestamp: ts,
        open: close, high: close + 0.5, low: close - 0.5, close, volume: 1_000_000, source: 'test',
      });
    }

    const result = await evaluateTrendFollowingExit('GAPWINDOW', 'BUY', ENTRY, 90 * DAY_MS);
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.actualReturn)).toBe(true);
    expect(result!.holdingPeriodDays).not.toBeNull();
    // holdingPeriodDays comes from real bar timestamps, not a bar-count assumption, so it must
    // still be a sane, non-negative number even though 4 calendar days of bars never existed.
    expect(result!.holdingPeriodDays!).toBeGreaterThan(0);
  });

  it('is idempotent - re-running the identical evaluation against unchanged data returns a bit-identical result', async () => {
    const lookback = Array.from({ length: 61 }, () => 100);
    const rise = Array.from({ length: 20 }, (_, i) => 100 + i * 1.2);
    const fall = Array.from({ length: 30 }, (_, i) => 124 - i * 3);
    await seedDailyBars('IDEMPOTENT', [...lookback, ...rise, ...fall]);

    const first = await evaluateTrendFollowingExit('IDEMPOTENT', 'BUY', ENTRY, 90 * DAY_MS);
    const second = await evaluateTrendFollowingExit('IDEMPOTENT', 'BUY', ENTRY, 90 * DAY_MS);
    expect(second).toEqual(first);
  });

  it('does not let bars backfilled AFTER an exit was already determined retroactively change that exit - no look-ahead through a growing cache', async () => {
    // The exact confound this guards against (found and fixed live, 2026-09-04, in
    // scripts/reevaluate_horizons.ts's own header comment): HistoricalDataGateway's ohlcv_bars
    // cache is a real, growing table, not an immutable snapshot. This proves that once a real
    // exit day is found by walking forward chronologically, appending MORE bars later in the same
    // window (simulating a later backfill) cannot change an already-determined earlier exit.
    const lookback = Array.from({ length: 61 }, () => 100);
    const rise = Array.from({ length: 20 }, (_, i) => 100 + i * 1.2);
    const fall = Array.from({ length: 30 }, (_, i) => 124 - i * 3);
    await seedDailyBars('GROWCACHE', [...lookback, ...rise, ...fall]);

    const before = await evaluateTrendFollowingExit('GROWCACHE', 'BUY', ENTRY, 90 * DAY_MS);
    expect(before).not.toBeNull();
    expect(before!.exitPrice).not.toBeNull(); // a real exit was found within the fall

    // Simulate a later backfill: add bars further into the SAME 90-day horizon window, well past
    // the already-found exit day, that swing price sharply back up - if the evaluator wrongly kept
    // scanning past its first real exit, or re-derived a different entry/exit from the enlarged
    // bar set, this would change the result.
    const laterBackfill = Array.from({ length: 30 }, (_, i) => 34 + i * 4); // days 51..80 after entry
    for (let i = 0; i < laterBackfill.length; i++) {
      const dayIndex = 60 + 20 + 30 + i + 1; // +1: existing lookback+rise+fall already occupies indices 0..110
      const ts = ENTRY - 60 * DAY_MS + dayIndex * DAY_MS;
      await db.insert(schema.ohlcvBars).values({
        id: `GROWCACHE:1Day:${ts}`, symbol: 'GROWCACHE', timeframe: '1Day', timestamp: ts,
        open: laterBackfill[i], high: laterBackfill[i] + 0.5, low: laterBackfill[i] - 0.5,
        close: laterBackfill[i], volume: 1_000_000, source: 'test',
      });
    }

    const after = await evaluateTrendFollowingExit('GROWCACHE', 'BUY', ENTRY, 90 * DAY_MS);
    expect(after).toEqual(before);
  });
});
