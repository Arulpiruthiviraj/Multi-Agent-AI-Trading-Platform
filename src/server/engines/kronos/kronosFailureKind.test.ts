import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyKronosForecastFailure } from './kronosFailureKind';
import { KronosEngine } from './KronosEngine';

describe('classifyKronosForecastFailure', () => {
  it('treats AbortSignal / fetch timeouts as transient (do not global-latch Kronos)', () => {
    expect(classifyKronosForecastFailure(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe('transient');
    expect(classifyKronosForecastFailure(new Error('KRONOS_UNAVAILABLE: local inference service not reachable at http://127.0.0.1:8008 (TimeoutError). Run \'npm run ai:serve\'.'))).toBe('transient');
    expect(classifyKronosForecastFailure(new Error('The operation was aborted'))).toBe('transient');
  });

  it('treats connection / HTTP hard failures as hard (markUnavailable until /health)', () => {
    expect(classifyKronosForecastFailure(new Error('KRONOS_UNAVAILABLE: local inference service not reachable at http://127.0.0.1:8008 (fetch failed). Run \'npm run ai:serve\'.'))).toBe('hard');
    expect(classifyKronosForecastFailure(new Error('KRONOS_UNAVAILABLE: local inference service returned 503: overloaded'))).toBe('hard');
    expect(classifyKronosForecastFailure(new Error('ECONNREFUSED'))).toBe('hard');
  });
});

describe('KronosEngine transient timeout does not latch global unavailable', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps manager ready after a per-symbol timeout so other symbols can still forecast', async () => {
    const engine = new KronosEngine();
    // Pretend Chronos health was already green; stamp lastCheckedAt so isReady() does not
    // fire a background /health probe against the vitest LOCAL_AI_SERVICE_URL.
    (engine.manager as any).isAvailable = true;
    (engine.manager as any).status = 'Ready';
    (engine.manager as any).lastCheckedAt = Date.now();
    const markSpy = vi.spyOn(engine.manager, 'markUnavailable');

    vi.spyOn(engine.inference, 'predict').mockRejectedValue(
      new Error('KRONOS_UNAVAILABLE: local inference service not reachable at http://127.0.0.1:8008 (TimeoutError). Run \'npm run ai:serve\'.'),
    );

    await expect(engine.predict('AAPL', 5, '1m', [1, 2, 3, 4, 5, 6])).rejects.toThrow(/TimeoutError/);
    expect(markSpy).not.toHaveBeenCalled();
    expect((engine.manager as any).isAvailable).toBe(true);
  });

  it('markUnavailable on hard connection failures (fail-closed globally until /health)', async () => {
    const engine = new KronosEngine();
    (engine.manager as any).isAvailable = true;
    (engine.manager as any).status = 'Ready';
    (engine.manager as any).lastCheckedAt = Date.now();
    const markSpy = vi.spyOn(engine.manager, 'markUnavailable').mockImplementation(function (this: any, reason?: string) {
      this.isAvailable = false;
      if (reason) {/* no-op */}
    });

    vi.spyOn(engine.inference, 'predict').mockRejectedValue(
      new Error('KRONOS_UNAVAILABLE: local inference service not reachable at http://127.0.0.1:8008 (fetch failed). Run \'npm run ai:serve\'.'),
    );

    await expect(engine.predict('MSFT', 5, '1m', [1, 2, 3, 4, 5, 6])).rejects.toThrow(/fetch failed/);
    expect(markSpy).toHaveBeenCalled();
  });
});
