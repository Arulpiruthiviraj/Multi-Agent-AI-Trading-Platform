import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/QuantCoreBridge', () => ({
  quantCoreBridge: {
    fetchResearchStrategy: vi.fn(),
    fetchInstitutionalEnsemble: vi.fn(),
  },
}));

const bar = (i: number, close: number) => ({ timestamp: i, open: close, high: close, low: close, close, volume: 1000 });
const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100 + i));

describe('computeInternalEnsembleQualification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when there are zero TS votes and every Java call fails closed', async () => {
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue(null);
    const { computeInternalEnsembleQualification } = await import('./internalQuantEnsemble');

    const result = await computeInternalEnsembleQualification('AAPL', bars as any, [], 'BUY');
    expect(result).toBeNull();
    expect(quantCoreBridge.fetchInstitutionalEnsemble).not.toHaveBeenCalled();
  });

  it('2026-09-11: logs a real EMPTY_VOTES outcome (never calls Java) when no evaluation has a recognized family - the "was it really 0 votes" question this P0 investigation needed to answer directly instead of reconstructing after the fact', async () => {
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue(null);
    const { structuredLogger } = await import('../observability/StructuredLogger');
    const logSpy = vi.fn();
    const restore = structuredLogger.info;
    structuredLogger.info = logSpy as any;
    try {
      const { computeInternalEnsembleQualification } = await import('./internalQuantEnsemble');
      await computeInternalEnsembleQualification('AAPL', bars as any, [{ strategy: 'NOT_A_REAL_STRATEGY', side: 'BUY', confidence: 0.9 } as any], 'BUY');
      const outcomeCall = logSpy.mock.calls.find((c) => c[0] === 'quant_ensemble_call_outcome');
      expect(outcomeCall).toBeDefined();
      expect(outcomeCall![1].reasoning).toContain('outcome=EMPTY_VOTES');
      expect(quantCoreBridge.fetchInstitutionalEnsemble).not.toHaveBeenCalled();
    } finally {
      structuredLogger.info = restore;
    }
  });

  it('never confirms the wrong direction when the ensemble rawSide disagrees with the idea side - but now returns a real, observable sideMismatch result instead of a bare null (2026-09-10 fix)', async () => {
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue(null);
    (quantCoreBridge.fetchInstitutionalEnsemble as any).mockResolvedValue({
      schemaVersion: 1, rawSide: 'SELL', totalVotes: 2, agreeingCount: 2, avgConfidenceOfAgreeing: 0.7,
      effectiveIndependentCount: 2, agreeingModelIds: ['TREND_FOLLOWING'], dissentingModelIds: [],
    });
    const { computeInternalEnsembleQualification } = await import('./internalQuantEnsemble');

    const evaluations = [
      { strategy: 'TREND_FOLLOWING', side: 'BUY', confidence: 0.7 } as any,
    ];
    const result = await computeInternalEnsembleQualification('AAPL', bars as any, evaluations, 'BUY');
    // Real behavior change (2026-09-10): still never qualifies as independent (identical
    // practical effect on ChiefTraderAgent.ts, which only ever checks qualifiesAsIndependent),
    // but the disagreement is now a real, distinguishable, observable result rather than an
    // indistinguishable-from-every-other-reason null.
    expect(result).not.toBeNull();
    expect(result!.qualifiesAsIndependent).toBe(false);
    expect(result!.sideMismatch).toBe(true);
    expect(result!.rawSide).toBe('SELL');
  });

  it('computes a real familyCount for the disagreeing side on sideMismatch (2026-09-11 fix - previously hardcoded to 0)', async () => {
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    (quantCoreBridge.fetchResearchStrategy as any).mockImplementation(async (id: string) => {
      if (id === 'rsi_mean_reversion') return { rsi: 8, fadeSignal: 'SELL' };
      return null;
    });
    // Ensemble resolves SELL, disagreeing with the idea's BUY. Two distinct families
    // (TREND_MOMENTUM via TREND_FOLLOWING, MEAN_REVERSION_FAMILY via rsi_mean_reversion) actually
    // agree with SELL - the whole point of this fix is that this is no longer reported as 0.
    (quantCoreBridge.fetchInstitutionalEnsemble as any).mockResolvedValue({
      schemaVersion: 1, rawSide: 'SELL', totalVotes: 2, agreeingCount: 2, avgConfidenceOfAgreeing: 0.7,
      effectiveIndependentCount: 1.9,
      agreeingModelIds: ['TREND_FOLLOWING', 'rsi_mean_reversion'],
      dissentingModelIds: [],
    });
    const { computeInternalEnsembleQualification } = await import('./internalQuantEnsemble');

    const evaluations = [
      { strategy: 'TREND_FOLLOWING', side: 'SELL', confidence: 0.7 } as any,
    ];
    const result = await computeInternalEnsembleQualification('AAPL', bars as any, evaluations, 'BUY');
    expect(result).not.toBeNull();
    expect(result!.sideMismatch).toBe(true);
    expect(result!.familyCount).toBe(2);
    expect(result!.agreeingFamilies.sort()).toEqual(['MEAN_REVERSION_FAMILY', 'TREND_MOMENTUM']);
  });

  it('genuinely fails closed to null when the Java ensemble call itself returns nothing (unchanged)', async () => {
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue(null);
    (quantCoreBridge.fetchInstitutionalEnsemble as any).mockResolvedValue(null);
    const { computeInternalEnsembleQualification } = await import('./internalQuantEnsemble');

    const evaluations = [{ strategy: 'TREND_FOLLOWING', side: 'BUY', confidence: 0.7 } as any];
    const result = await computeInternalEnsembleQualification('AAPL', bars as any, evaluations, 'BUY');
    expect(result).toBeNull();
  });

  it('qualifies when enough distinct families agree and effectiveIndependentCount clears the bar', async () => {
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    (quantCoreBridge.fetchResearchStrategy as any).mockImplementation(async (id: string) => {
      if (id === 'rsi_mean_reversion') return { rsi: 8, fadeSignal: 'BUY' };
      return null;
    });
    (quantCoreBridge.fetchInstitutionalEnsemble as any).mockResolvedValue({
      schemaVersion: 1, rawSide: 'BUY', totalVotes: 3, agreeingCount: 3, avgConfidenceOfAgreeing: 0.7,
      effectiveIndependentCount: 2.8,
      agreeingModelIds: ['TREND_FOLLOWING', 'MOMENTUM_BREAKOUT', 'rsi_mean_reversion'],
      dissentingModelIds: [],
    });
    const { computeInternalEnsembleQualification } = await import('./internalQuantEnsemble');

    const evaluations = [
      { strategy: 'TREND_FOLLOWING', side: 'BUY', confidence: 0.7 } as any,
      { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', confidence: 0.65 } as any,
    ];
    const result = await computeInternalEnsembleQualification('AAPL', bars as any, evaluations, 'BUY');
    expect(result).not.toBeNull();
    expect(result!.qualifiesAsIndependent).toBe(true);
    expect(result!.familyCount).toBe(3); // TREND_MOMENTUM, BREAKOUT_VOLATILITY, MEAN_REVERSION_FAMILY
    expect(result!.effectiveIndependentCount).toBe(2.8);
  });

  it('does not qualify when families are insufficient even with several agreeing strategies (fake independence guard)', async () => {
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue(null);
    (quantCoreBridge.fetchInstitutionalEnsemble as any).mockResolvedValue({
      schemaVersion: 1, rawSide: 'BUY', totalVotes: 2, agreeingCount: 2, avgConfidenceOfAgreeing: 0.65,
      effectiveIndependentCount: 1.1, // heavily correlated - same family
      agreeingModelIds: ['TREND_FOLLOWING', 'PULLBACK_CONTINUATION'],
      dissentingModelIds: [],
    });
    const { computeInternalEnsembleQualification } = await import('./internalQuantEnsemble');

    // Both TREND_FOLLOWING and PULLBACK_CONTINUATION map to the same TREND_MOMENTUM family -
    // exactly the "fake independence" scenario this whole mechanism exists to prevent.
    const evaluations = [
      { strategy: 'TREND_FOLLOWING', side: 'BUY', confidence: 0.7 } as any,
      { strategy: 'PULLBACK_CONTINUATION', side: 'BUY', confidence: 0.65 } as any,
    ];
    const result = await computeInternalEnsembleQualification('AAPL', bars as any, evaluations, 'BUY');
    expect(result).not.toBeNull();
    expect(result!.familyCount).toBe(1);
    expect(result!.qualifiesAsIndependent).toBe(false);
  });

  it('ignores HOLD-side TS evaluations and unrecognized strategy ids', async () => {
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue(null);
    (quantCoreBridge.fetchInstitutionalEnsemble as any).mockResolvedValue({
      schemaVersion: 1, rawSide: 'BUY', totalVotes: 1, agreeingCount: 1, avgConfidenceOfAgreeing: 0.7,
      effectiveIndependentCount: 1, agreeingModelIds: ['TREND_FOLLOWING'], dissentingModelIds: [],
    });
    const { computeInternalEnsembleQualification } = await import('./internalQuantEnsemble');

    const evaluations = [
      { strategy: 'TREND_FOLLOWING', side: 'BUY', confidence: 0.7 } as any,
      { strategy: 'TREND_FOLLOWING', side: 'HOLD', confidence: 0.9 } as any,
      { strategy: 'NOT_A_REAL_STRATEGY', side: 'BUY', confidence: 0.9 } as any,
    ];
    await computeInternalEnsembleQualification('AAPL', bars as any, evaluations, 'BUY');

    const callArg = (quantCoreBridge.fetchInstitutionalEnsemble as any).mock.calls[0][0];
    expect(callArg).toHaveLength(1);
    expect(callArg[0].modelId).toBe('TREND_FOLLOWING');
  });
});

describe('shouldSuppressForConfluenceGuard (2026-09-11, "ARGUS - Quant-First Architecture Transformation" Section 7)', () => {
  const mismatchEnsemble = (familyCount: number, effectiveIndependentCount: number) => ({
    qualifiesAsIndependent: false, rawSide: 'SELL' as const, effectiveIndependentCount,
    familyCount, agreeingFamilies: [], totalVotes: 2, agreeingModelIds: [], dissentingModelIds: [],
    sideMismatch: true,
  });

  it('never suppresses when the guard flag is off, no matter how strong the disagreement', async () => {
    const { shouldSuppressForConfluenceGuard } = await import('./internalQuantEnsemble');
    expect(shouldSuppressForConfluenceGuard(false, mismatchEnsemble(5, 5), 3, 2.5)).toBe(false);
  });

  it('never suppresses when there is no ensemble result at all', async () => {
    const { shouldSuppressForConfluenceGuard } = await import('./internalQuantEnsemble');
    expect(shouldSuppressForConfluenceGuard(true, null, 3, 2.5)).toBe(false);
  });

  it('never suppresses when the ensemble agreed with the idea (sideMismatch false), even if enabled', async () => {
    const { shouldSuppressForConfluenceGuard } = await import('./internalQuantEnsemble');
    const agreeing = { ...mismatchEnsemble(5, 5), sideMismatch: false, qualifiesAsIndependent: true };
    expect(shouldSuppressForConfluenceGuard(true, agreeing, 3, 2.5)).toBe(false);
  });

  it('does not suppress when the guard is on but the disagreement is weak (below the bar)', async () => {
    const { shouldSuppressForConfluenceGuard } = await import('./internalQuantEnsemble');
    expect(shouldSuppressForConfluenceGuard(true, mismatchEnsemble(1, 1.0), 3, 2.5)).toBe(false);
  });

  it('suppresses only when enabled, mismatched, AND the disagreement clears the exact same bar as independent qualification', async () => {
    const { shouldSuppressForConfluenceGuard } = await import('./internalQuantEnsemble');
    expect(shouldSuppressForConfluenceGuard(true, mismatchEnsemble(3, 2.5), 3, 2.5)).toBe(true);
    // Family count alone is not enough without effective count, and vice versa.
    expect(shouldSuppressForConfluenceGuard(true, mismatchEnsemble(3, 2.4), 3, 2.5)).toBe(false);
    expect(shouldSuppressForConfluenceGuard(true, mismatchEnsemble(2, 3.0), 3, 2.5)).toBe(false);
  });
});
