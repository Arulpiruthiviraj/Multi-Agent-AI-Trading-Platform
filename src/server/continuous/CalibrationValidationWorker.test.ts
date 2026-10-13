import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/**
 * Real gap found and fixed (2026-09-15, post-forensic-audit timer sweep): runOnce() had no
 * overlap guard - a slow runCalibrationValidationCycle() cycle outlasting the 900s interval could
 * create two concurrent shadow versions for the same (agent, bucket) versionType. These tests
 * prove the fix's single-flight coalescing directly, without waiting on a real 900s interval.
 */
describe('CalibrationValidationWorker single-flight guard', () => {
  // Pin the clock outside the regular session (Saturday) so these single-flight tests do not depend on the
  // 2026-10-13 regular-session deferral (see the dedicated describe below).
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-10T15:00:00Z') }); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('concurrent runOnce() calls coalesce - a slow in-flight cycle is not run twice in overlap', async () => {
    let cycleCalls = 0;
    let resolveFirstCycle: (() => void) | null = null;
    vi.doMock('./CalibrationCandidateBuilder', () => ({
      runCalibrationValidationCycle: vi.fn(async () => {
        cycleCalls += 1;
        if (cycleCalls === 1) {
          await new Promise<void>((resolve) => { resolveFirstCycle = resolve; });
        }
        return [];
      }),
    }));

    const { calibrationValidationWorker } = await import('./CalibrationValidationWorker');

    const first = calibrationValidationWorker.runOnce();
    while (cycleCalls < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const second = calibrationValidationWorker.runOnce();

    resolveFirstCycle!();
    await Promise.all([first, second]);

    expect(cycleCalls).toBe(1); // the overlapping second call coalesced, not a duplicate cycle
    expect(calibrationValidationWorker.getGuardMetrics().totalSkippedInFlight).toBeGreaterThanOrEqual(1);
  });

  it('sequential (non-overlapping) runOnce() calls each run a real cycle - the guard only coalesces genuine overlap', async () => {
    let cycleCalls = 0;
    vi.doMock('./CalibrationCandidateBuilder', () => ({
      runCalibrationValidationCycle: vi.fn(async () => {
        cycleCalls += 1;
        return [];
      }),
    }));

    const { calibrationValidationWorker } = await import('./CalibrationValidationWorker');

    await calibrationValidationWorker.runOnce();
    await calibrationValidationWorker.runOnce();

    expect(cycleCalls).toBe(2);
  });

  it('getStatus() reflects a real completed cycle count and timestamp', async () => {
    vi.doMock('./CalibrationCandidateBuilder', () => ({
      runCalibrationValidationCycle: vi.fn(async () => ([{ agentName: 'X' }, { agentName: 'Y' }])),
    }));

    const { calibrationValidationWorker } = await import('./CalibrationValidationWorker');
    await calibrationValidationWorker.runOnce();

    const status = calibrationValidationWorker.getStatus();
    expect(status.lastRunCount).toBe(2);
    expect(status.lastRunAt).not.toBeNull();
  });
});

describe('CalibrationValidationWorker regular-session deferral (2026-10-13)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetModules(); });

  async function load() {
    const cycle = vi.fn(async () => []);
    vi.doMock('./CalibrationCandidateBuilder', () => ({ runCalibrationValidationCycle: cycle }));
    const { calibrationValidationWorker } = await import('./CalibrationValidationWorker');
    const { tradingSafety } = await import('../config/tradingSafety');
    return { calibrationValidationWorker, cycle, tradingSafety };
  }

  it('does NOT run the research cycle during the regular session, and records the deferral', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T15:00:00Z') }); // 11:00 ET Tue
    const { calibrationValidationWorker, cycle } = await load();
    await calibrationValidationWorker.runOnce();
    expect(cycle).not.toHaveBeenCalled();
    expect(calibrationValidationWorker.shouldDeferNow()).toBe(true);
  });

  it('runs outside the regular session (premarket, after close, weekend)', async () => {
    for (const iso of ['2026-10-13T12:00:00Z', '2026-10-13T21:00:00Z', '2026-10-17T15:00:00Z']) {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });
      const { calibrationValidationWorker, cycle } = await load();
      await calibrationValidationWorker.runOnce();
      expect(cycle, iso).toHaveBeenCalledTimes(1);
      vi.resetModules();
    }
  });

  it('the deferral is configuration-controlled (flag off -> runs in the regular session)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T15:00:00Z') });
    const { calibrationValidationWorker, cycle, tradingSafety } = await load();
    const prev = tradingSafety.calibrationValidationDeferDuringRegularSession;
    (tradingSafety as any).calibrationValidationDeferDuringRegularSession = false;
    try {
      await calibrationValidationWorker.runOnce();
      expect(cycle).toHaveBeenCalledTimes(1);
    } finally { (tradingSafety as any).calibrationValidationDeferDuringRegularSession = prev; }
  });
});
