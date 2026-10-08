import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Lifecycle verification for the AI provider health monitor (TIMERS/SCHEDULERS hunt,
 * 2026-10-08): the DEF-4 fix made startAIProviderHealthMonitor() idempotent and gave it a
 * stopAIProviderHealthMonitor(). This suite proves the lifecycle properties directly -
 * exactly one live interval no matter how often start() is called, zero timers after
 * stop(), a clean restart after stop(), and - the property that actually matters for the
 * drain - that no provider probe fires once the monitor is stopped.
 */
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => Promise.resolve([]) }) },
}));
vi.mock('../core/EncryptionService', () => ({
  EncryptionService: { decrypt: () => { throw new Error('no key in test'); } },
}));

import { AIRouter } from './AIRouter';
import type { AIProvider } from './providers/AIProvider';
import {
  startAIProviderHealthMonitor,
  stopAIProviderHealthMonitor,
  resetAIProviderHealthTrackerForTests,
} from './AIProviderHealthCheck';
import { runtimeIntervals } from '../config/runtimeIntervals';

function countingProvider(counter: { calls: number }): AIProvider {
  return {
    initialize: async () => {},
    authenticate: async () => { counter.calls += 1; return true; },
    chat: async () => ({ content: 'OK', tokens: 2, inputTokens: 1, outputTokens: 1 }),
    stream: (async function* () { yield ''; }) as unknown as (prompt: string, options?: any) => AsyncGenerator<string, void, unknown>,
    embeddings: async () => [],
    vision: async () => ({ content: '', tokens: 0 }),
    image: async () => Buffer.from(''),
    health: async () => 'Healthy',
    estimateCost: () => 0,
    estimateLatency: () => 100,
    supportsTools: () => false,
    supportsReasoning: () => false,
    supportsStreaming: () => false,
    supportsVision: () => false,
    supportsStructuredOutput: () => false,
  } as AIProvider;
}

describe('AIProviderHealthCheck start/stop lifecycle', () => {
  const counter = { calls: 0 };

  beforeEach(() => {
    vi.useFakeTimers();
    counter.calls = 0;
    AIRouter.getInstance().registerProvider('lifecycle-probe', countingProvider(counter));
  });

  afterEach(() => {
    resetAIProviderHealthTrackerForTests();
    vi.useRealTimers();
  });

  it('double-start creates exactly one interval; stop() leaves zero timers', async () => {
    expect(vi.getTimerCount()).toBe(0);
    startAIProviderHealthMonitor();
    startAIProviderHealthMonitor();
    expect(vi.getTimerCount()).toBe(1);
    stopAIProviderHealthMonitor();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => stopAIProviderHealthMonitor()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no provider probe fires after stop() - restart starts exactly one fresh interval', async () => {
    startAIProviderHealthMonitor();
    // Let the immediate startup tick and two full interval ticks run.
    await vi.advanceTimersByTimeAsync(runtimeIntervals.aiProviderHealthCheckMs * 2 + 1000);
    const callsWhileRunning = counter.calls;
    expect(callsWhileRunning).toBeGreaterThanOrEqual(2);

    stopAIProviderHealthMonitor();
    await vi.advanceTimersByTimeAsync(runtimeIntervals.aiProviderHealthCheckMs * 3);
    expect(counter.calls).toBe(callsWhileRunning); // nothing fired while stopped

    // Clean restart: one interval again, probes resume.
    startAIProviderHealthMonitor();
    startAIProviderHealthMonitor();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(runtimeIntervals.aiProviderHealthCheckMs + 1000);
    expect(counter.calls).toBeGreaterThan(callsWhileRunning);
    stopAIProviderHealthMonitor();
    expect(vi.getTimerCount()).toBe(0);
  });
});
