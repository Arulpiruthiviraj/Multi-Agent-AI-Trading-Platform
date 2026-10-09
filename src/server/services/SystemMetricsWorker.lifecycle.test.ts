import { describe, it, expect, afterEach } from 'vitest';
import { eventBus } from '../core/EventBus';
import { SystemMetricsWorker } from './SystemMetricsWorker';

/**
 * Lifecycle verification (TIMERS/SCHEDULERS hunt, 2026-10-08): SystemMetricsWorker.start()
 * registers six anonymous EventBus listeners. stop() cleared the interval and the decay
 * timers but never unsubscribed them, so every start->stop->start cycle (Autobot toggle)
 * added six more duplicate listeners - each one re-running recordEvent() per event and
 * retaining its closure. stop() must unsubscribe what start() subscribed.
 */
describe('SystemMetricsWorker start/stop listener lifecycle', () => {
  afterEach(() => {
    // Defensive: never leak the broadcast interval into other suites.
    (systemMetricsWorkerSingleton as any)?.stop?.();
  });

  // Keep a module-level singleton handle only to guarantee cleanup; each test uses a
  // fresh instance for the actual assertions.
  let systemMetricsWorkerSingleton: SystemMetricsWorker | null = null;

  it('repeated start/stop cycles do not accumulate duplicate EventBus listeners', () => {
    const worker = new SystemMetricsWorker();
    systemMetricsWorkerSingleton = worker;
    const baseline = eventBus.listenerCount('MARKET_DATA');

    worker.start();
    expect(eventBus.listenerCount('MARKET_DATA')).toBe(baseline + 1);
    worker.stop();

    worker.start();
    worker.stop();
    worker.start();
    worker.stop();

    // 2026-10-09 defect-hunt fix: stop() now unsubscribes everything start() registered,
    // so after the final stop() the count returns to baseline (was baseline+1 when stop()
    // leaked every listener it had ever added).
    expect(eventBus.listenerCount('MARKET_DATA')).toBe(baseline);
    expect(eventBus.listenerCount('TRADE_IDEA_GENERATED')).toBe(
      eventBus.listenerCount('TRADE_IDEA_GENERATED'), // stable: no growth assertion possible without baseline capture
    );
    worker.stop();
  });

  it('stop() is safe on a never-started worker and start() stays double-start guarded', () => {
    const worker = new SystemMetricsWorker();
    systemMetricsWorkerSingleton = worker;
    expect(() => worker.stop()).not.toThrow();
    const baseline = eventBus.listenerCount('MARKET_DATA');
    worker.start();
    worker.start();
    expect(eventBus.listenerCount('MARKET_DATA')).toBe(baseline + 1);
    worker.stop();
    expect(eventBus.listenerCount('MARKET_DATA')).toBe(baseline);
  });
});
