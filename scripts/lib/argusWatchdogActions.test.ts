/**
 * Tests for watchdog restart-action safety (defect #3):
 *  (d) a watchdog-initiated restart must NEVER clear TRADING_PAUSED / resume trading;
 *  (e) the watchdog must never start a second engine while one holds the atomic startup claim.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRestartSpawnSpec,
  assertRestartSpecNeverResumesTrading,
  shouldAttemptEngineSpawn,
} from './argusWatchdogActions';

describe('defect #3 (d): watchdog restart never auto-enables trading', () => {
  it('the restart spec is exactly `argus-cli start` with no trading-resume flag', () => {
    const spec = buildRestartSpawnSpec('/repo-root');
    expect(spec.args[spec.args.length - 1]).toBe('start');
    expect(spec.args).not.toContain('--enable-trading');
    expect(spec.args.some((a) => a.startsWith('--enable-trading'))).toBe(false);
    // The runtime assertion the watchdog itself runs before every spawn passes for this spec.
    expect(() => assertRestartSpecNeverResumesTrading(spec)).not.toThrow();
  });

  it('assertRestartSpecNeverResumesTrading throws if a resume flag ever sneaks into the spec', () => {
    const evil = { ...buildRestartSpawnSpec('/repo-root'), args: [...buildRestartSpawnSpec('/repo-root').args, '--enable-trading'] };
    expect(() => assertRestartSpecNeverResumesTrading(evil)).toThrow(/WATCHDOG SAFETY VIOLATION/);
  });

  it('evaluateRestartSafety never unpauses: TRADING_PAUSED stays paused across a watchdog restart', async () => {
    // Engine-side of the same invariant: boot restores the persisted tradingState as-is
    // (TradingEngine.initialize) and evaluateRestartSafety() can only force-pause, never
    // unpause. A watchdog restart therefore cannot clear TRADING_PAUSED.
    const { evaluateRestartSafety } = await import('../../src/server/core/sessionRecovery');
    expect(evaluateRestartSafety(true, 'TRADING_PAUSED')).toEqual({ shouldForcePause: false, reason: '' });
    expect(evaluateRestartSafety(false, 'TRADING_PAUSED')).toEqual({ shouldForcePause: false, reason: '' });
    expect(evaluateRestartSafety(true, 'EMERGENCY_STOP')).toEqual({ shouldForcePause: false, reason: '' });
    // And the one direction it DOES act: unclean shutdown + persisted ENABLED -> force pause.
    const r = evaluateRestartSafety(true, 'TRADING_ENABLED');
    expect(r.shouldForcePause).toBe(true);
  });
});

describe('defect #3 (e): single-engine coordination - never spawn while the startup claim is held', () => {
  let dir: string;
  let pidPath: string;
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'argus-pid-'));
    pidPath = join(dir, '.argus_engine.pid');
    process.env.ARGUS_ENGINE_PID_PATH = pidPath;
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to spawn when a live process holds the atomic startup claim', async () => {
    const { writeEnginePid } = await import('../../src/server/app/enginePid');
    writeEnginePid(process.pid); // this test process is alive -> claim held
    const gate = shouldAttemptEngineSpawn();
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/atomic startup claim held/);
  });

  it('allows spawn when no engine pid file exists', () => {
    const gate = shouldAttemptEngineSpawn();
    expect(gate.ok).toBe(true);
  });

  it('clears a stale pid file and allows spawn (no live process holds the claim)', async () => {
    const { writeFileSync } = await import('node:fs');
    // A PID that is (almost surely) not alive: pick one far outside the live range and verify.
    const { isPidAlive } = await import('../../src/server/app/enginePid');
    const stalePid = 4_000_000_000;
    if (isPidAlive(stalePid)) return; // absurd corner - don't assert on a live pid
    writeFileSync(pidPath, String(stalePid), 'utf8');
    const gate = shouldAttemptEngineSpawn();
    expect(gate.ok).toBe(true);
    expect(gate.reason).toMatch(/stale/);
  });
});
