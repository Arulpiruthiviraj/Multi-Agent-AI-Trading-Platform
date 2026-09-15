import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { observabilityConfig } from '../config/observability';

// This file exists specifically to exercise heap-snapshot capture, so it opts back in to the
// suite-wide default vitest.setup.ts applies (ARGUS_DISABLE_HEAP_SNAPSHOTS=true, so unrelated
// tests that happen to drive a WARNING/CRITICAL memory sample don't write real files). node:v8 and
// node:fs are fully mocked below regardless, so no real snapshot is ever written even with this on.
process.env.ARGUS_DISABLE_HEAP_SNAPSHOTS = 'false';

const writeHeapSnapshotMock = vi.fn((path?: string) => path ?? '/tmp/fake.heapsnapshot');
vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>();
  return {
    ...actual,
    writeHeapSnapshot: (path?: string) => writeHeapSnapshotMock(path),
  };
});

const fsState = { files: new Map<string, { mtimeMs: number; size: number }>() };
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn((_dir: string) => [...fsState.files.keys()]),
    statSync: vi.fn((path: string) => {
      const name = path.split(/[\\/]/).pop()!;
      const entry = fsState.files.get(name) ?? { mtimeMs: 0, size: 0 };
      return { mtimeMs: entry.mtimeMs, size: entry.size };
    }),
    unlinkSync: vi.fn((path: string) => {
      const name = path.split(/[\\/]/).pop()!;
      fsState.files.delete(name);
    }),
  };
});

// Imported AFTER the mocks above so the module under test picks up the mocked node:v8/node:fs.
import {
  captureHeapSnapshot,
  maybeCaptureHeapSnapshotForMemoryLevel,
  scheduleBaselineHeapSnapshot,
  stopHeapSnapshotScheduler,
  resetHeapSnapshotStateForTests,
} from './heapSnapshotCapture';

describe('heapSnapshotCapture (P1 memory-leak investigation, 2026-09-14)', () => {
  // config/observability.json's real default is now heapSnapshotEnabled=false (elevated-level
  // capture disabled 2026-09-14 after a real incident - see that file's own comment). This test
  // file exercises the mechanism itself (fully mocked node:v8/node:fs, no real snapshot ever
  // written) regardless of the live default, matching how the explicit "disabled" test below
  // still separately proves the false-case short-circuit.
  let enabledSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetHeapSnapshotStateForTests();
    writeHeapSnapshotMock.mockClear();
    fsState.files.clear();
    vi.useFakeTimers();
    enabledSpy = vi.spyOn(observabilityConfig, 'heapSnapshotEnabled', 'get').mockReturnValue(true);
  });

  afterEach(() => {
    stopHeapSnapshotScheduler();
    vi.useRealTimers();
    enabledSpy.mockRestore();
  });

  describe('captureHeapSnapshot()', () => {
    it('calls v8.writeHeapSnapshot and reports success with a measured duration', async () => {
      const result = await captureHeapSnapshot('test-reason');
      expect(result.ok).toBe(true);
      expect(result.path).toBeTruthy();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1);
    });

    it('fails open (never throws) when v8.writeHeapSnapshot throws', async () => {
      writeHeapSnapshotMock.mockImplementationOnce(() => { throw new Error('disk full'); });
      const result = await captureHeapSnapshot('test-reason');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('disk full');
    });

    it('is a no-op when heapSnapshotEnabled is false, without calling writeHeapSnapshot', async () => {
      const spy = vi.spyOn(observabilityConfig, 'heapSnapshotEnabled', 'get').mockReturnValue(false);
      try {
        const result = await captureHeapSnapshot('test-reason');
        expect(result.ok).toBe(false);
        expect(writeHeapSnapshotMock).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('maybeCaptureHeapSnapshotForMemoryLevel() - state machine', () => {
    it('never captures for NORMAL', () => {
      maybeCaptureHeapSnapshotForMemoryLevel('NORMAL');
      expect(writeHeapSnapshotMock).not.toHaveBeenCalled();
    });

    it('captures exactly once on the first WARNING/CRITICAL crossing', () => {
      maybeCaptureHeapSnapshotForMemoryLevel('WARNING');
      expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1);
    });

    it('does not re-capture immediately (cooldown), even if level flaps WARNING<->CRITICAL', () => {
      maybeCaptureHeapSnapshotForMemoryLevel('WARNING');
      maybeCaptureHeapSnapshotForMemoryLevel('CRITICAL');
      maybeCaptureHeapSnapshotForMemoryLevel('WARNING');
      expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1);
    });

    it('takes exactly one follow-up snapshot after heapSnapshotFollowUpDelayMs if still elevated', () => {
      // Deliberately controlled, well-separated test values (cooldown well under the follow-up
      // delay) rather than relying on the real config's relative magnitudes - keeps this test's
      // intent unambiguous and independent of future config tuning.
      const cooldownSpy = vi.spyOn(observabilityConfig, 'heapSnapshotCooldownMs', 'get').mockReturnValue(60000);
      const followUpSpy = vi.spyOn(observabilityConfig, 'heapSnapshotFollowUpDelayMs', 'get').mockReturnValue(300000);
      try {
        maybeCaptureHeapSnapshotForMemoryLevel('WARNING'); // first crossing
        expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1);

        // Not enough time has passed yet - no follow-up.
        vi.advanceTimersByTime(299000);
        maybeCaptureHeapSnapshotForMemoryLevel('CRITICAL');
        expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1);

        // Now past the follow-up delay (300000ms total) and well past cooldown (60000ms).
        vi.advanceTimersByTime(2000);
        maybeCaptureHeapSnapshotForMemoryLevel('CRITICAL');
        expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(2);

        // A third elevated sample, arbitrarily far in the future, must NOT trigger a third capture -
        // only one follow-up is ever taken.
        vi.advanceTimersByTime(10 * 60000);
        maybeCaptureHeapSnapshotForMemoryLevel('CRITICAL');
        expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(2);
      } finally {
        cooldownSpy.mockRestore();
        followUpSpy.mockRestore();
      }
    });

    it('never exceeds heapSnapshotMaxPerProcessLifetime regardless of how many elevated samples arrive', () => {
      const spy = vi.spyOn(observabilityConfig, 'heapSnapshotMaxPerProcessLifetime', 'get').mockReturnValue(1);
      try {
        maybeCaptureHeapSnapshotForMemoryLevel('WARNING');
        expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(observabilityConfig.heapSnapshotCooldownMs + observabilityConfig.heapSnapshotFollowUpDelayMs + 1000);
        maybeCaptureHeapSnapshotForMemoryLevel('CRITICAL');
        expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1); // capped at 1, no follow-up allowed
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('scheduleBaselineHeapSnapshot() / stopHeapSnapshotScheduler()', () => {
    it('captures a baseline snapshot after heapSnapshotBaselineDelayMs', () => {
      scheduleBaselineHeapSnapshot();
      expect(writeHeapSnapshotMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(observabilityConfig.heapSnapshotBaselineDelayMs);
      expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1);
    });

    it('never fires the baseline snapshot once stopped', () => {
      scheduleBaselineHeapSnapshot();
      stopHeapSnapshotScheduler();
      vi.advanceTimersByTime(observabilityConfig.heapSnapshotBaselineDelayMs + 1000);
      expect(writeHeapSnapshotMock).not.toHaveBeenCalled();
    });
  });

  describe('disk pruning', () => {
    it('deletes the oldest files before writing a new one once the file-count cap would be exceeded', async () => {
      const spy = vi.spyOn(observabilityConfig, 'heapSnapshotMaxFilesOnDisk', 'get').mockReturnValue(2);
      try {
        fsState.files.set('old1.heapsnapshot', { mtimeMs: 1000, size: 1 });
        fsState.files.set('old2.heapsnapshot', { mtimeMs: 2000, size: 1 });
        await captureHeapSnapshot('reason');
        // Oldest (old1) should have been pruned to make room under the cap of 2.
        expect(fsState.files.has('old1.heapsnapshot')).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
