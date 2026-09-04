/**
 * Readiness pass (2026-09-04): durable memory telemetry sampler. See processTelemetry.ts's own
 * header comment on sampleAndPersistMemoryTelemetry() for why this exists - the pre-existing
 * process telemetry ring is in-memory only and lost on process death.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const fakeTradingEngine = vi.hoisted(() => ({
  state: { tradingState: 'TRADING_ENABLED' as string },
  setTradingState: vi.fn(async (newState: string, _opts: unknown) => {
    fakeTradingEngine.state.tradingState = newState;
    return { ok: true, fromState: 'TRADING_ENABLED', toState: newState, cancelledOrderIds: [] };
  }),
}));
vi.mock('../engines/TradingEngine', () => ({ tradingEngine: fakeTradingEngine }));

import {
  classifyRss,
  classifyCommitted,
  worstLevel,
  parseSidecarMemoryMb,
  parseSidecarCommittedMb,
  parseSidecarThreadCount,
  sampleAndPersistMemoryTelemetry,
  applyMemoryCriticalFailSafe,
} from './processTelemetry';
import { observabilityConfig } from '../config/observability';
import * as StructuredLoggerModule from './StructuredLogger';

describe('parseSidecarMemoryMb', () => {
  it('parses the real local_ai_service.py /health label format', () => {
    expect(parseSidecarMemoryMb('586 MB · N/A (CPU/MPS)')).toBe(586);
    expect(parseSidecarMemoryMb('42890.4 MB')).toBeCloseTo(42890.4);
  });

  it('returns null for unavailable/unknown labels rather than fabricating a number', () => {
    expect(parseSidecarMemoryMb('N/A (CPU/MPS)')).toBeNull();
    expect(parseSidecarMemoryMb('unknown')).toBeNull();
    expect(parseSidecarMemoryMb(undefined)).toBeNull();
    expect(parseSidecarMemoryMb(null)).toBeNull();
  });
});

describe('classifyRss', () => {
  it('classifies below the warning threshold as NORMAL', () => {
    expect(classifyRss(observabilityConfig.memoryTelemetryWarningRssMb - 1)).toBe('NORMAL');
  });
  it('classifies at/above warning but below critical as WARNING', () => {
    expect(classifyRss(observabilityConfig.memoryTelemetryWarningRssMb)).toBe('WARNING');
    expect(classifyRss(observabilityConfig.memoryTelemetryCriticalRssMb - 1)).toBe('WARNING');
  });
  it('classifies at/above critical as CRITICAL', () => {
    expect(classifyRss(observabilityConfig.memoryTelemetryCriticalRssMb)).toBe('CRITICAL');
  });
});

describe('parseSidecarCommittedMb', () => {
  it('accepts the numeric /health field', () => {
    expect(parseSidecarCommittedMb(15247.72)).toBeCloseTo(15247.7);
    expect(parseSidecarCommittedMb(0)).toBe(0);
  });

  it('returns null rather than fabricating a value for a missing/invalid field', () => {
    expect(parseSidecarCommittedMb(undefined)).toBeNull();
    expect(parseSidecarCommittedMb(null)).toBeNull();
    expect(parseSidecarCommittedMb('15247')).toBeNull();
    expect(parseSidecarCommittedMb(Number.NaN)).toBeNull();
    expect(parseSidecarCommittedMb(-1)).toBeNull();
  });
});

describe('parseSidecarThreadCount', () => {
  it('accepts a plain integer thread count, distinct from the MB-rounding parsers', () => {
    expect(parseSidecarThreadCount(6451)).toBe(6451);
    expect(parseSidecarThreadCount(0)).toBe(0);
  });

  it('returns null rather than fabricating a value for a missing/invalid field', () => {
    expect(parseSidecarThreadCount(undefined)).toBeNull();
    expect(parseSidecarThreadCount(null)).toBeNull();
    expect(parseSidecarThreadCount('6451')).toBeNull();
    expect(parseSidecarThreadCount(Number.NaN)).toBeNull();
    expect(parseSidecarThreadCount(-1)).toBeNull();
  });
});

describe('classifyCommitted', () => {
  it('uses its own thresholds, distinct from the RSS ones', () => {
    expect(classifyCommitted(observabilityConfig.memoryTelemetryWarningCommittedMb - 1)).toBe('NORMAL');
    expect(classifyCommitted(observabilityConfig.memoryTelemetryWarningCommittedMb)).toBe('WARNING');
    expect(classifyCommitted(observabilityConfig.memoryTelemetryCriticalCommittedMb)).toBe('CRITICAL');
  });

  it('committed thresholds sit above the RSS ones so a healthy PyTorch process does not alarm', () => {
    expect(observabilityConfig.memoryTelemetryWarningCommittedMb)
      .toBeGreaterThan(observabilityConfig.memoryTelemetryWarningRssMb);
    expect(observabilityConfig.memoryTelemetryCriticalCommittedMb)
      .toBeGreaterThan(observabilityConfig.memoryTelemetryCriticalRssMb);
  });
});

describe('worstLevel', () => {
  it('returns the highest severity present and ignores nulls', () => {
    expect(worstLevel('NORMAL', null, 'WARNING')).toBe('WARNING');
    expect(worstLevel('WARNING', 'CRITICAL')).toBe('CRITICAL');
    expect(worstLevel(null, null)).toBe('NORMAL');
    expect(worstLevel('CRITICAL', null, 'NORMAL')).toBe('CRITICAL');
  });
});

describe('sampleAndPersistMemoryTelemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('persists a NORMAL sample and honestly reports the sidecar unreachable when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const infoSpy = vi.spyOn(StructuredLoggerModule.structuredLogger, 'info');

    await sampleAndPersistMemoryTelemetry();

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [, fields] = infoSpy.mock.calls[0];
    expect(fields?.eventType).toBe('MEMORY_TELEMETRY_SAMPLE');
    expect(fields?.sidecarReachable).toBe(false);
    expect(fields?.sidecarRssMb).toBeNull();
    expect(fields?.level).toBe('NORMAL');
    expect(typeof fields?.nodeRssMb).toBe('number');
  });

  it('never blocks or throws when the sidecar health fetch times out or errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise((_, reject) => reject(new Error('timeout')))));
    await expect(sampleAndPersistMemoryTelemetry()).resolves.toBeUndefined();
  });

  it('escalates on the sidecar COMMITTED signal even when both RSS numbers look NORMAL (the real 2026-09-03 blind spot)', async () => {
    // The exact live-measured shape of the miss: 102MB RSS reported while the process actually held
    // 15,247MB of private commit. Before this fix the sampler recorded level=NORMAL for that.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ memoryUsage: '470 MB · N/A (CPU/MPS)', committedMemoryMb: 15245.9, threadCount: 6451 }),
    }));
    const errorSpy = vi.spyOn(StructuredLoggerModule.structuredLogger, 'error');

    await sampleAndPersistMemoryTelemetry();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [, fields] = errorSpy.mock.calls[0];
    expect(fields?.eventType).toBe('MEMORY_TELEMETRY_SAMPLE');
    expect(fields?.sidecarRssMb).toBe(470);
    expect(fields?.sidecarCommittedMb).toBeCloseTo(15245.9);
    // Recorded for later baseline derivation, but must never itself drive severity.
    expect(fields?.sidecarThreadCount).toBe(6451);
    expect(fields?.level).toBe('CRITICAL');
  });

  it('records sidecarCommittedMb as null (never fabricated, never downgrading) for an older sidecar with no such field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ memoryUsage: '480 MB · N/A (CPU/MPS)' }),
    }));
    const infoSpy = vi.spyOn(StructuredLoggerModule.structuredLogger, 'info');

    await sampleAndPersistMemoryTelemetry();

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [, fields] = infoSpy.mock.calls[0];
    expect(fields?.sidecarCommittedMb).toBeNull();
    expect(fields?.sidecarReachable).toBe(true);
    expect(fields?.level).toBe('NORMAL');
  });

  it('escalates to WARNING when the sidecar reports elevated memory even if Node itself is NORMAL', async () => {
    const highMb = observabilityConfig.memoryTelemetryWarningRssMb + 100;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ memoryUsage: `${highMb} MB · N/A (CPU/MPS)` }),
    }));
    const warnSpy = vi.spyOn(StructuredLoggerModule.structuredLogger, 'warn');

    await sampleAndPersistMemoryTelemetry();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, fields] = warnSpy.mock.calls[0];
    expect(fields?.sidecarReachable).toBe(true);
    expect(fields?.sidecarRssMb).toBe(highMb);
    expect(fields?.level).toBe('WARNING');
  });
});

describe('applyMemoryCriticalFailSafe (2026-09-04 full-remediation pass)', () => {
  beforeEach(() => {
    fakeTradingEngine.state.tradingState = 'TRADING_ENABLED';
    fakeTradingEngine.setTradingState.mockClear();
  });

  it('pauses trading via the EXISTING TRADING_PAUSED mechanism when currently enabled', async () => {
    await applyMemoryCriticalFailSafe(4200, 15245.9);

    expect(fakeTradingEngine.setTradingState).toHaveBeenCalledTimes(1);
    const [newState, opts] = fakeTradingEngine.setTradingState.mock.calls[0] as [string, { actor: string; reason: string }];
    expect(newState).toBe('TRADING_PAUSED');
    expect(opts.actor).toBe('MemoryTelemetryGuard');
    expect(opts.reason).toContain('CRITICAL');
    expect(opts.reason).toContain('4200');
  });

  it('is idempotent - does not call setTradingState again if already paused (no audit-log spam on a persisting condition)', async () => {
    fakeTradingEngine.state.tradingState = 'TRADING_PAUSED';
    await applyMemoryCriticalFailSafe(4200, 15245.9);
    expect(fakeTradingEngine.setTradingState).not.toHaveBeenCalled();
  });

  it('is idempotent for EMERGENCY_STOP too - never overrides a more severe existing state', async () => {
    fakeTradingEngine.state.tradingState = 'EMERGENCY_STOP';
    await applyMemoryCriticalFailSafe(4200, 15245.9);
    expect(fakeTradingEngine.setTradingState).not.toHaveBeenCalled();
  });

  it('never throws even if setTradingState itself fails - a broken fail-safe must not become a new crash path', async () => {
    fakeTradingEngine.setTradingState.mockRejectedValueOnce(new Error('db write failed'));
    await expect(applyMemoryCriticalFailSafe(4200, null)).resolves.toBeUndefined();
  });

  it('sampleAndPersistMemoryTelemetry triggers the fail-safe end-to-end on a real CRITICAL sample, and does not on WARNING/NORMAL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ memoryUsage: '470 MB · N/A (CPU/MPS)', committedMemoryMb: observabilityConfig.memoryTelemetryCriticalCommittedMb, threadCount: 6451 }),
    }));
    await sampleAndPersistMemoryTelemetry();
    expect(fakeTradingEngine.setTradingState).toHaveBeenCalledWith('TRADING_PAUSED', expect.objectContaining({ actor: 'MemoryTelemetryGuard' }));

    fakeTradingEngine.state.tradingState = 'TRADING_ENABLED';
    fakeTradingEngine.setTradingState.mockClear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));
    await sampleAndPersistMemoryTelemetry(); // NORMAL (node RSS low, sidecar unreachable)
    expect(fakeTradingEngine.setTradingState).not.toHaveBeenCalled();
  });
});
