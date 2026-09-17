import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Determinism fix regression (2026-09-15, Rule 2 of the market-open simulator follow-up mandate):
 * ARGUS_NEWS_ENGINE_ENABLED='false' must make bootArgusCore() skip newsEngine.start() entirely -
 * the real fix for a confirmed non-determinism source (real RSS/LLM news ingest running on its own
 * real-time schedule during a deterministic, seeded synthetic simulation). Own file/own process-wide
 * coreBooted state, same convention as ArgusCoreBoot.restartSafety.test.ts.
 */
describe('ArgusCoreBoot - ARGUS_NEWS_ENGINE_ENABLED=false skips NewsEngine start', () => {
  let tmpDbPath: string;
  let tmpSessionPath: string;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_coreboot_newsdisable_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    process.env.ARGUS_NEWS_ENGINE_ENABLED = 'false';

    const { setSessionRecoveryPathForTests } = await import('./sessionRecovery');
    tmpSessionPath = path.join(os.tmpdir(), `argus_coreboot_newsdisable_session_${Date.now()}_${process.pid}.json`);
    setSessionRecoveryPathForTests(tmpSessionPath);

    const { db } = await import('../db');
    const schema = await import('../db/schema');
    await db.insert(schema.settings).values({
      tradingMode: 'PAPER', riskLevel: 'Medium', budget: 50000,
      strategy: 'ADAPTIVE_MULTI_STRATEGY', maxTradeSize: 3000, dailyLossLimit: 5000,
      takeProfitPct: 15, trailingStopPct: 5, minAiConfidence: 75, adversarialDebateMode: true,
      autoBotEnabled: false, tradingState: 'TRADING_PAUSED',
    } as any);
  });

  afterAll(async () => {
    const { resetArgusCoreBootedForTests } = await import('./ArgusCoreBoot');
    const { resetSessionRecoveryForTests } = await import('./sessionRecovery');
    resetArgusCoreBootedForTests();
    resetSessionRecoveryForTests();
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmpSessionPath); } catch { /* ignore */ }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.ARGUS_NEWS_ENGINE_ENABLED;
  });

  it('does not call newsEngine.start() when the flag is false, and production default (unset) still does', async () => {
    const { newsEngine } = await import('../news/NewsEngine');
    const startSpy = vi.spyOn(newsEngine, 'start');

    const { bootArgusCore } = await import('./ArgusCoreBoot');
    await bootArgusCore();

    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
  }, 30000); // real full boot (AIRouter startup health probes over real network) - matches ArgusCoreBoot.restartSafety.test.ts's own boot cost
});
