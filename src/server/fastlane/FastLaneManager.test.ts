import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fastLaneManager } from './FastLaneManager';
import { structuredLogger } from '../observability/StructuredLogger';

/**
 * 2026-10-05: Tests for the Fast Opportunity Lane candidate lifecycle.
 * These run with the feature flag OFF by default (verifying no-op behavior)
 * and ON for the lifecycle tests.
 */
describe('FastLaneManager', () => {
  beforeEach(() => {
    fastLaneManager.resetForTests();
    vi.spyOn(structuredLogger, 'info').mockImplementation(() => {});
    delete process.env.FAST_OPPORTUNITY_LANE_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FAST_OPPORTUNITY_LANE_ENABLED;
    fastLaneManager.resetForTests();
  });

  it('is disabled by default (feature flag off → inject returns null)', () => {
    const result = fastLaneManager.injectCandidate({
      symbol: 'MXL',
      detectionSource: 'PRICE_ACCELERATION',
      liquidityEvidence: { dollarVolume: 1_000_000, spreadBps: 20, meetsMinLiquidity: true },
    });
    expect(result).toBeNull();
    expect(fastLaneManager.countForTests()).toBe(0);
  });

  it('creates a candidate when enabled', () => {
    process.env.FAST_OPPORTUNITY_LANE_ENABLED = 'true';
    const c = fastLaneManager.injectCandidate({
      symbol: 'mxl',
      detectionSource: 'NEWS_CATALYST',
      catalyst: 'Puma 9 launch',
      priceAnomaly: { movePct: 9.9, timeframeMin: 60, vsBaseline: 'PREV_CLOSE' },
      liquidityEvidence: { dollarVolume: 5_000_000, spreadBps: 15, meetsMinLiquidity: true },
      applicableStrategies: ['MOMENTUM_CONTINUATION'],
    });
    expect(c).not.toBeNull();
    expect(c!.symbol).toBe('MXL'); // uppercased
    expect(c!.state).toBe('DETECTED');
    expect(c!.expiresAt).toBeGreaterThan(c!.detectedAt);
    expect(c!.stateHistory).toHaveLength(1);
  });

  it('deduplicates active candidates per symbol', () => {
    process.env.FAST_OPPORTUNITY_LANE_ENABLED = 'true';
    const input = {
      symbol: 'SYNA',
      detectionSource: 'RVOL_SPIKE' as const,
      liquidityEvidence: { dollarVolume: 1_000_000, spreadBps: 20, meetsMinLiquidity: true },
    };
    const first = fastLaneManager.injectCandidate(input);
    const second = fastLaneManager.injectCandidate(input);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // duplicate blocked
    expect(fastLaneManager.countForTests()).toBe(1);
  });

  it('expires candidates past TTL', () => {
    process.env.FAST_OPPORTUNITY_LANE_ENABLED = 'true';
    const c = fastLaneManager.injectCandidate({
      symbol: 'WOLF',
      detectionSource: 'PRICE_ACCELERATION',
      liquidityEvidence: { dollarVolume: 1_000_000, spreadBps: 20, meetsMinLiquidity: true },
      ttlMs: 1, // 1ms TTL
    });
    expect(c).not.toBeNull();
    // Wait for expiry
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const active = fastLaneManager.getActiveCandidates();
        expect(active.find((x) => x.id === c!.id)).toBeUndefined();
        resolve();
      }, 10);
    });
  });

  it('transitions state with history', () => {
    process.env.FAST_OPPORTUNITY_LANE_ENABLED = 'true';
    const c = fastLaneManager.injectCandidate({
      symbol: 'PTC',
      detectionSource: 'NEWS_CATALYST',
      liquidityEvidence: { dollarVolume: 1_000_000, spreadBps: 20, meetsMinLiquidity: true },
    });
    expect(c).not.toBeNull();
    const ok = fastLaneManager.transitionState(c!.id, 'DATA_READY', 'snapshot acquired');
    expect(ok).toBe(true);
    const updated = fastLaneManager.getCandidate(c!.id)!;
    expect(updated.state).toBe('DATA_READY');
    expect(updated.stateHistory).toHaveLength(2);
    expect(updated.stateHistory[1].reason).toBe('snapshot acquired');
  });

  it('fails closed for LIVE mode even with flag set', () => {
    process.env.FAST_OPPORTUNITY_LANE_ENABLED = 'true';
    process.env.TRADING_MODE = 'LIVE';
    const result = fastLaneManager.injectCandidate({
      symbol: 'MXL',
      detectionSource: 'PRICE_ACCELERATION',
      liquidityEvidence: { dollarVolume: 1_000_000, spreadBps: 20, meetsMinLiquidity: true },
    });
    expect(result).toBeNull();
    delete process.env.TRADING_MODE;
  });
});
