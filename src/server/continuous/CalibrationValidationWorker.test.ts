import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Real gap found and fixed (2026-09-15, post-forensic-audit timer sweep): runOnce() had no
 * overlap guard - a slow runCalibrationValidationCycle() cycle outlasting the 900s interval could
 * create two concurrent shadow versions for the same (agent, bucket) versionType. These tests
 * prove the fix's single-flight coalescing directly, without waiting on a real 900s interval.
 */
describe('CalibrationValidationWorker single-flight guard', () => {
  afterEach(() => {
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
