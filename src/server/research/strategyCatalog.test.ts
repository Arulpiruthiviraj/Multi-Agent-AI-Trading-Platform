import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('strategyCatalog', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('./strategyCatalog');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_strategy_catalog_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    mod = await import('./strategyCatalog');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('lists all 5 CORE strategies as tier CORE, always live-eligible, with real family + ownership', async () => {
    const rows = await mod.buildStrategyCatalog();
    const coreIds = ['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'MEAN_REVERSION', 'TREND_FOLLOWING', 'RANGE_REVERSION'];
    for (const id of coreIds) {
      const row = rows.find((r) => r.strategyId === id && r.tier === 'CORE')!;
      expect(row).toBeDefined();
      expect(row.liveEligible).toBe(true);
      expect(row.enabledEnvVar).toBeNull();
      expect(row.family).not.toBeNull();
      expect(row.ownership).not.toBeNull();
      expect(row.ownership!.owner).toBe('NODE_AUTHORITATIVE');
      expect(row.lifecycleStatus).toBe('UNTESTED');
    }
  });

  it('lists EXPERIMENTAL strategies as not live-eligible by default, with a real enabledEnvVar and null ownership', async () => {
    const rows = await mod.buildStrategyCatalog();
    const row = rows.find((r) => r.strategyId === 'OSCILLATOR_MOMENTUM')!;
    expect(row).toBeDefined();
    expect(row.tier).toBe('EXPERIMENTAL');
    expect(row.liveEligible).toBe(false);
    expect(row.enabledEnvVar).toBe('QUANT_OSCILLATOR_MOMENTUM_ENABLED');
    expect(row.ownership).toBeNull();
  });

  it('flips liveEligible to true for an EXPERIMENTAL strategy once its real env flag is set - never fabricated', async () => {
    process.env.QUANT_OSCILLATOR_MOMENTUM_ENABLED = 'true';
    try {
      const rows = await mod.buildStrategyCatalog();
      const row = rows.find((r) => r.strategyId === 'OSCILLATOR_MOMENTUM')!;
      expect(row.liveEligible).toBe(true);
    } finally {
      delete process.env.QUANT_OSCILLATOR_MOMENTUM_ENABLED;
    }
  });

  it('lists Java RESEARCH strategy ids as tier JAVA_RESEARCH, gated by the real Java bridge flag', async () => {
    const rows = await mod.buildStrategyCatalog();
    const row = rows.find((r) => r.strategyId === 'rsi_mean_reversion')!;
    expect(row).toBeDefined();
    expect(row.tier).toBe('JAVA_RESEARCH');
    expect(row.family).toBe('MEAN_REVERSION_FAMILY');
    expect(row.liveEligible).toBe(false); // QUANT_JAVA_CORE_ENABLED not set in this test env
  });

  it('formatStrategyCatalog renders a readable text table', async () => {
    const rows = await mod.buildStrategyCatalog();
    const text = mod.formatStrategyCatalog(rows);
    expect(text).toContain('STRATEGY CATALOG');
    expect(text).toContain('MOMENTUM_BREAKOUT');
    expect(text).toContain('JAVA_RESEARCH');
  });
});
