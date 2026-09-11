import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../ai/AIProviderHealthCheck', () => ({
  getAIProviderHealthSnapshot: vi.fn(),
}));

import { getAIProviderHealthSnapshot } from '../ai/AIProviderHealthCheck';
import { quantCoreBridge } from '../services/QuantCoreBridge';
import { computeAiAvailability, computeQuantAvailability } from './aiQuantAvailability';

describe('computeAiAvailability', () => {
  it('reports AI_UNAVAILABLE when zero providers are registered', async () => {
    (getAIProviderHealthSnapshot as any).mockResolvedValue([]);
    const snap = await computeAiAvailability();
    expect(snap.state).toBe('AI_UNAVAILABLE');
    expect(snap.registeredProviderCount).toBe(0);
  });

  it('reports AI_UNAVAILABLE when providers are registered but none are healthy', async () => {
    (getAIProviderHealthSnapshot as any).mockResolvedValue([
      { status: 'AUTH_FAILED' }, { status: 'TIMEOUT' },
    ]);
    const snap = await computeAiAvailability();
    expect(snap.state).toBe('AI_UNAVAILABLE');
    expect(snap.healthyProviderCount).toBe(0);
  });

  it('reports AI_DEGRADED when some but not all providers are healthy', async () => {
    (getAIProviderHealthSnapshot as any).mockResolvedValue([
      { status: 'HEALTHY' }, { status: 'RATE_LIMITED' }, { status: 'HEALTHY' },
    ]);
    const snap = await computeAiAvailability();
    expect(snap.state).toBe('AI_DEGRADED');
    expect(snap.healthyProviderCount).toBe(2);
    expect(snap.registeredProviderCount).toBe(3);
  });

  it('reports AI_HEALTHY when every registered provider is healthy', async () => {
    (getAIProviderHealthSnapshot as any).mockResolvedValue([
      { status: 'HEALTHY' }, { status: 'HEALTHY' },
    ]);
    const snap = await computeAiAvailability();
    expect(snap.state).toBe('AI_HEALTHY');
  });

  it('tallies per-status counts for observability', async () => {
    (getAIProviderHealthSnapshot as any).mockResolvedValue([
      { status: 'HEALTHY' }, { status: 'HEALTHY' }, { status: 'QUOTA_EXCEEDED' },
    ]);
    const snap = await computeAiAvailability();
    expect(snap.statuses).toEqual({ HEALTHY: 2, QUOTA_EXCEEDED: 1 });
  });
});

describe('computeQuantAvailability', () => {
  const originalEnv = process.env.QUANT_JAVA_CORE_ENABLED;

  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.QUANT_JAVA_CORE_ENABLED;
    else process.env.QUANT_JAVA_CORE_ENABLED = originalEnv;
  });

  it('reports QUANT_HEALTHY (javaConnected: null) when Java is disabled - TS StrategyEngine is unaffected either way', async () => {
    const snap = await computeQuantAvailability();
    expect(snap.state).toBe('QUANT_HEALTHY');
    expect(snap.javaEnabled).toBe(false);
    expect(snap.javaConnected).toBeNull();
  });

  it('reports QUANT_HEALTHY when Java is enabled and a LIVE health check succeeds - never a passive/stale cache read', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const healthSpy = vi.spyOn(quantCoreBridge, 'health').mockResolvedValue({ connected: true, checkedAt: new Date().toISOString() });

    const snap = await computeQuantAvailability();
    expect(snap.state).toBe('QUANT_HEALTHY');
    expect(snap.javaEnabled).toBe(true);
    expect(snap.javaConnected).toBe(true);
    expect(healthSpy).toHaveBeenCalled(); // a real live check was performed, not cachedHealth()
    vi.restoreAllMocks();
  });

  it('reports QUANT_DEGRADED (never QUANT_UNAVAILABLE) when Java is enabled but a live check finds it unreachable', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    vi.spyOn(quantCoreBridge, 'health').mockResolvedValue({ connected: false, checkedAt: new Date().toISOString(), detail: 'ECONNREFUSED' });

    const snap = await computeQuantAvailability();
    expect(snap.state).toBe('QUANT_DEGRADED');
    expect(snap.javaConnected).toBe(false);
    vi.restoreAllMocks();
  });

  it('does not report QUANT_DEGRADED merely because a passive cache is stale - regression test for the bug found live on a fresh restart 2026-09-10', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    // Simulate a freshly-booted bridge: cachedHealth() still at its constructor default
    // (never checked), but a real live health() call succeeds. The old implementation read
    // cachedHealth() and would have wrongly reported QUANT_DEGRADED here.
    vi.spyOn(quantCoreBridge, 'cachedHealth').mockReturnValue({ connected: false, checkedAt: new Date(0).toISOString(), detail: 'never checked' });
    vi.spyOn(quantCoreBridge, 'health').mockResolvedValue({ connected: true, checkedAt: new Date().toISOString() });

    const snap = await computeQuantAvailability();
    expect(snap.state).toBe('QUANT_HEALTHY');
    vi.restoreAllMocks();
  });

  it('never returns QUANT_UNAVAILABLE - no TS-side failure signal exists for this pass to detect (documented limitation, not a bug)', async () => {
    // Exhaustive over the only two real inputs this function reads: javaEnabled x connected.
    for (const enabled of ['true', undefined]) {
      if (enabled) process.env.QUANT_JAVA_CORE_ENABLED = enabled; else delete process.env.QUANT_JAVA_CORE_ENABLED;
      for (const connected of [true, false]) {
        vi.spyOn(quantCoreBridge, 'health').mockResolvedValue({ connected, checkedAt: new Date().toISOString() });
        const snap = await computeQuantAvailability();
        expect(snap.state).not.toBe('QUANT_UNAVAILABLE');
        vi.restoreAllMocks();
      }
    }
  });
});
