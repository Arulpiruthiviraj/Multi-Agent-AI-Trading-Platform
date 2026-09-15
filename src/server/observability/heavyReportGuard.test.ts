import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { observabilityConfig } from '../config/observability';
import {
  guardHeavyReport,
  HeavyReportRefusedError,
  isHeavyReportInProgress,
  resetHeavyReportGuardForTests,
  setRssReaderForTests,
} from './heavyReportGuard';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('heavyReportGuard (trading/research-plane isolation, 2026-09-14, item #25)', () => {
  beforeEach(() => {
    resetHeavyReportGuardForTests();
    // Default to a healthy, low RSS so tests aren't accidentally gated by this real process's
    // own actual memory usage during a full-suite run.
    setRssReaderForTests(() => 200);
  });

  afterEach(() => {
    resetHeavyReportGuardForTests();
  });

  it('runs the wrapped function and returns its result when nothing else is in progress', async () => {
    const result = await guardHeavyReport('test-report', async () => 'ok');
    expect(result).toBe('ok');
    expect(isHeavyReportInProgress()).toBe(false);
  });

  it('refuses a second concurrent heavy report while the first is still running', async () => {
    let releaseFirst!: () => void;
    const first = guardHeavyReport('first', () => new Promise<string>((resolve) => { releaseFirst = () => resolve('first-done'); }));
    // Let the first call actually acquire the mutex before attempting the second.
    await sleep(5);
    expect(isHeavyReportInProgress()).toBe(true);

    await expect(guardHeavyReport('second', async () => 'second-done')).rejects.toMatchObject({
      code: 'CONCURRENT_HEAVY_REPORT',
    });
    expect(isHeavyReportInProgress()).toBe(true); // first is still running

    releaseFirst();
    await expect(first).resolves.toBe('first-done');
    expect(isHeavyReportInProgress()).toBe(false);
  });

  it('refuses to start when RSS is already at or above the warning threshold', async () => {
    setRssReaderForTests(() => observabilityConfig.memoryTelemetryWarningRssMb);
    const fn = vi.fn(async () => 'should-not-run');
    await expect(guardHeavyReport('test-report', fn)).rejects.toMatchObject({
      code: 'MEMORY_ELEVATED',
    });
    expect(fn).not.toHaveBeenCalled();
    expect(isHeavyReportInProgress()).toBe(false); // never acquired
  });

  it('allows a heavy report when RSS is comfortably below the warning threshold', async () => {
    setRssReaderForTests(() => observabilityConfig.memoryTelemetryWarningRssMb - 500);
    await expect(guardHeavyReport('test-report', async () => 'ok')).resolves.toBe('ok');
  });

  it('releases the mutex even when the wrapped function throws', async () => {
    await expect(guardHeavyReport('failing-report', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(isHeavyReportInProgress()).toBe(false);
  });

  it('times out the CALLER but keeps the mutex held until the real underlying work finishes (honest, not a fake cancel)', async () => {
    const timeoutSpy = vi.spyOn(observabilityConfig, 'heavyReportTimeoutMs', 'get').mockReturnValue(20);
    try {
      let releaseUnderlying!: () => void;
      const call = guardHeavyReport('slow-report', () => new Promise<string>((resolve) => { releaseUnderlying = () => resolve('finally-done'); }));

      await expect(call).rejects.toMatchObject({ code: 'TIMEOUT' });
      // The caller was released, but the real work is still "running" (we haven't resolved it
      // yet) - the mutex must still be held, proving this isn't a fake cancel.
      expect(isHeavyReportInProgress()).toBe(true);

      releaseUnderlying();
      await sleep(5);
      expect(isHeavyReportInProgress()).toBe(false); // now released, because the real work finished
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('HeavyReportRefusedError carries a stable, checkable code for callers (e.g. HTTP 429 mapping)', () => {
    const err = new HeavyReportRefusedError('MEMORY_ELEVATED', 'test message');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('MEMORY_ELEVATED');
    expect(err.name).toBe('HeavyReportRefusedError');
  });
});
