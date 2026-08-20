import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ArgusCoreBoot', () => {
  let tmpDbPath: string;
  let sqliteDb: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_coreboot_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
  });

  afterAll(async () => {
    const { resetArgusCoreBootedForTests } = await import('./ArgusCoreBoot');
    resetArgusCoreBootedForTests();
    try { sqliteDb?.close(); } catch { /* ignore */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('boots engine spine without Express or Vite', async () => {
    const { bootArgusCore, isArgusCoreBooted } = await import('./ArgusCoreBoot');
    const { tradingEngine } = await import('../engines/TradingEngine');
    const { system } = await import('./SystemBootstrap');
    const { BrokerManager } = await import('../../brokers/BrokerManager');

    expect(isArgusCoreBooted()).toBe(false);
    await bootArgusCore();
    expect(isArgusCoreBooted()).toBe(true);
    expect(BrokerManager.getInstance().getActiveBroker()).toBeTruthy();

    expect(tradingEngine.state.tradingMode).toBeTruthy();
    expect(system.getStatus().dbConnected).toBe(true);

    ({ sqliteDb } = await import('../db'));
  }, 120_000);
});
