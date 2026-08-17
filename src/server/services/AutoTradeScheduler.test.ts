import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('AutoTradeScheduler.tick', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let autoTradeScheduler: any;
  let tradingEngine: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_ats_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ autoTradeScheduler } = await import('./AutoTradeScheduler'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    await db.insert(schema.settings).values({});
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('is a no-op when the schedule is disabled (default, zero behavior change)', async () => {
    await db.update(schema.settings).set({ autoTradeScheduleEnabled: false }).run();
    const toggleSpy = vi.spyOn(tradingEngine, 'toggle');
    await autoTradeScheduler.tick();
    expect(toggleSpy).not.toHaveBeenCalled();
    toggleSpy.mockRestore();
  });

  it('fails closed (skips, does not call toggle) when the configured window is invalid', async () => {
    await db.update(schema.settings).set({
      autoTradeScheduleEnabled: true,
      autoTradeScheduleStartTime: 'not-a-time',
      autoTradeScheduleEndTime: '16:00',
    }).run();
    const toggleSpy = vi.spyOn(tradingEngine, 'toggle');
    await autoTradeScheduler.tick();
    expect(toggleSpy).not.toHaveBeenCalled();
    toggleSpy.mockRestore();
  });
});
