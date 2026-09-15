import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * P1 restart-safety hardening (2026-09-14, item #26) - end-to-end regression proving the real
 * boot wiring (ArgusCoreBoot.ts) applies evaluateRestartSafety()'s decision, not just the pure
 * function in isolation (sessionRecovery.test.ts already covers that). Own file (own module
 * registry / own coreBooted=false starting state) since bootArgusCore() is idempotent per process
 * and ArgusCoreBoot.test.ts already consumes the one boot this process gets in its own file.
 */
describe('ArgusCoreBoot - restart safety end-to-end', () => {
  let tmpDbPath: string;
  let tmpSessionPath: string;
  let sqliteDb: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_coreboot_restartsafety_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';

    const { setSessionRecoveryPathForTests } = await import('./sessionRecovery');
    tmpSessionPath = path.join(os.tmpdir(), `argus_coreboot_restartsafety_session_${Date.now()}_${process.pid}.json`);
    setSessionRecoveryPathForTests(tmpSessionPath);

    // Simulate the prior process's marker: it started, never shut down cleanly (cleanShutdown
    // stays false until a graceful exit flips it), and its heartbeat is old enough to be
    // unambiguous - exactly what a real unclean death leaves behind.
    fs.writeFileSync(tmpSessionPath, JSON.stringify({
      pid: 999999,
      parentPid: null,
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      lastHeartbeatAt: new Date(Date.now() - 1800000).toISOString(),
      cleanShutdown: false,
      exitCode: null,
    }));

    // Pre-seed the settings row with a persisted TRADING_ENABLED - the exact real-world condition
    // this fix closes (a resumed session whose process then died uncleanly).
    const { db } = await import('../db');
    const schema = await import('../db/schema');
    await db.insert(schema.settings).values({
      tradingMode: 'PAPER',
      riskLevel: 'Medium',
      budget: 50000,
      strategy: 'ADAPTIVE_MULTI_STRATEGY',
      maxTradeSize: 3000,
      dailyLossLimit: 5000,
      takeProfitPct: 15,
      trailingStopPct: 5,
      minAiConfidence: 75,
      adversarialDebateMode: true,
      autoBotEnabled: false,
      tradingState: 'TRADING_ENABLED',
    } as any);
  });

  afterAll(async () => {
    const { resetArgusCoreBootedForTests } = await import('./ArgusCoreBoot');
    const { resetSessionRecoveryForTests } = await import('./sessionRecovery');
    resetArgusCoreBootedForTests();
    resetSessionRecoveryForTests();
    try { sqliteDb?.close(); } catch { /* ignore */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmpSessionPath); } catch { /* ignore */ }
    delete process.env.ARGUS_DB_PATH;
  });

  it('forces TRADING_PAUSED on boot when the prior session died uncleanly with a persisted TRADING_ENABLED', async () => {
    const { bootArgusCore } = await import('./ArgusCoreBoot');
    const { tradingEngine } = await import('../engines/TradingEngine');

    await bootArgusCore();

    // The real invariant this fix adds: NOT simply inherited from the persisted row (which said
    // TRADING_ENABLED) - explicitly downgraded because the prior process's death was unclean.
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');

    ({ sqliteDb } = await import('../db'));

    // Confirm it was recorded as a real, auditable kill-switch transition, not a silent state flip.
    const { db } = await import('../db');
    const schema = await import('../db/schema');
    const events = await db.select().from(schema.killSwitchEvents);
    const restartSafetyEvent = events.find((e: any) => e.actor === 'RestartSafetyGuard');
    expect(restartSafetyEvent).toBeTruthy();
    expect(restartSafetyEvent?.toState).toBe('TRADING_PAUSED');
    expect(restartSafetyEvent?.reason).toContain('explicit operator reactivation');

    // Overnight remediation (2026-09-14, mandate section 5): explicit LIVE_NO_GO assertion on the
    // exact same post-unclean-restart process, not just TRADING_PAUSED. PAPER_TRADING_ONLY=true is
    // already set in this file's own beforeAll - this proves the authoritative live-readiness
    // engine agrees, not just the trading-state flag in isolation.
    const { evaluateLiveReadiness } = await import('./liveReadinessEngine');
    const readiness = evaluateLiveReadiness();
    expect(readiness.result).toBe('LIVE_NO_GO');

    // And explicit reactivation remains necessary - TRADING_PAUSED does not resolve itself; only
    // an explicit resume call (already covered elsewhere - TradingEngine.setTradingState()) can.
    expect(tradingEngine.state.tradingState).not.toBe('TRADING_ENABLED');
  }, 120_000);
});
