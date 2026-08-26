import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { tradingSafety } from '../config/tradingSafety';
import { researchSafety } from '../config/researchSafety';

describe('PeakEquityIntegrity (Peak Equity Recovery, 2026-08-26)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: typeof import('../db').db;
  let schema: typeof import('../db/schema');
  let reconcilePeakEquityIntegrity: typeof import('./PeakEquityIntegrity').reconcilePeakEquityIntegrity;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_peakequity_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb, db } = await import('../db'));
    schema = await import('../db/schema');
    ({ reconcilePeakEquityIntegrity } = await import('./PeakEquityIntegrity'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function seedSettings(peakEquity: number | null) {
    const existing = await db.select().from(schema.settings).limit(1);
    if (existing.length === 0) {
      await db.insert(schema.settings).values({ peakEquity: peakEquity ?? undefined } as any);
    } else {
      await db.update(schema.settings).set({ peakEquity }).run();
    }
  }

  async function seedOrganicPaperTrades(count: number) {
    await db.delete(schema.trades).run();
    for (let i = 0; i < count; i++) {
      await db.insert(schema.trades).values({
        id: `paper-trade-${i}`,
        symbol: 'AAPL',
        side: i % 2 === 0 ? 'BUY' : 'SELL',
        quantity: 1,
        price: 100,
        status: 'FILLED',
        timestamp: new Date().toISOString(),
        executionEnvironment: 'PAPER',
      });
    }
  }

  beforeEach(async () => {
    await db.delete(schema.trades).run();
    await db.delete(schema.configChangeEvents).run();
  });

  it('CLEAN: no stored peak yet — no-op, no write', async () => {
    await seedSettings(null);
    const outcome = await reconcilePeakEquityIntegrity(100050.26);
    expect(outcome.status).toBe('CLEAN');
    const events = await db.select().from(schema.configChangeEvents);
    expect(events.length).toBe(0);
  });

  it('CLEAN: real growth (100k -> 120k -> 115k) must retain the legitimate peak, never reset merely because current < peak', async () => {
    await seedSettings(120000);
    const outcome = await reconcilePeakEquityIntegrity(115000); // within any reasonable multiplier of current equity
    expect(outcome.status).toBe('CLEAN');
    const row = (await db.select().from(schema.settings).limit(1))[0];
    expect(row.peakEquity).toBe(120000); // untouched
  });

  it('the exact real-world scenario: peak=1,000,000 vs real equity ~100,050 with only 3 organic trades -> CONTAMINATED_AND_REPAIRED', async () => {
    await seedSettings(1000000);
    await seedOrganicPaperTrades(3); // matches the real audit finding: 3 organic PAPER fills all-time
    expect(3).toBeLessThan(researchSafety.minPaperTrades);

    const outcome = await reconcilePeakEquityIntegrity(100050.26);
    expect(outcome.status).toBe('CONTAMINATED_AND_REPAIRED');
    if (outcome.status === 'CONTAMINATED_AND_REPAIRED') {
      expect(outcome.oldValue).toBe(1000000);
      expect(outcome.newValue).toBe(100050.26);
    }

    const row = (await db.select().from(schema.settings).limit(1))[0];
    expect(row.peakEquity).toBe(100050.26);

    const events = await db.select().from(schema.configChangeEvents);
    expect(events.length).toBe(1);
    expect(events[0].setting).toBe('peakEquity');
    expect(events[0].oldEffective).toBe('1000000');
    expect(events[0].newValue).toBe('100050.26');
    expect(events[0].operator).toBe('system-auto-repair');
  });

  it('SUSPICIOUS_BUT_PLAUSIBLE: a large multiple WITH real trading history is never auto-repaired', async () => {
    await seedSettings(1000000);
    await seedOrganicPaperTrades(researchSafety.minPaperTrades + 5); // enough real history to plausibly explain growth

    const outcome = await reconcilePeakEquityIntegrity(100050.26);
    expect(outcome.status).toBe('SUSPICIOUS_BUT_PLAUSIBLE');

    const row = (await db.select().from(schema.settings).limit(1))[0];
    expect(row.peakEquity).toBe(1000000); // untouched — reported, not guessed

    const events = await db.select().from(schema.configChangeEvents);
    expect(events.length).toBe(0);
  });

  it('SKIPPED_INVALID_EQUITY: never evaluates against a missing/invalid broker equity read', async () => {
    await seedSettings(1000000);
    const outcome = await reconcilePeakEquityIntegrity(NaN);
    expect(outcome.status).toBe('SKIPPED_INVALID_EQUITY');
    const row = (await db.select().from(schema.settings).limit(1))[0];
    expect(row.peakEquity).toBe(1000000); // untouched
  });

  it('is idempotent: running again after a repair reports CLEAN and writes no further events', async () => {
    await seedSettings(1000000);
    await seedOrganicPaperTrades(3);
    await reconcilePeakEquityIntegrity(100050.26);

    const second = await reconcilePeakEquityIntegrity(100050.26);
    expect(second.status).toBe('CLEAN');
    const events = await db.select().from(schema.configChangeEvents);
    expect(events.length).toBe(1); // still just the one real repair, not a second
  });

  it('never touches consensus thresholds', () => {
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
    expect(tradingSafety.disagreementPenalty).toBe(0.5);
  });
});
