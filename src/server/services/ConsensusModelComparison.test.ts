import { describe, it, expect, vi } from 'vitest';
import { recordConsensusModelComparison } from './ConsensusModelComparison';
import type { ShadowConsensusResult } from './EvidenceAwareVote';

function shadow(overrides: Partial<ShadowConsensusResult>): ShadowConsensusResult {
  return {
    finalDecision: 'HOLD', aggregateConfidence: 0, bullishEvidence: 0, bearishEvidence: 0,
    uncertainty: 1, excludedAgents: [], reasonCode: 'NO_USABLE_EVIDENCE', ...overrides,
  };
}

describe('recordConsensusModelComparison', () => {
  it('marks agree=true when both legacy and shadow reject', async () => {
    const logSpy = vi.fn();
    const { structuredLogger } = await import('../observability/StructuredLogger');
    const restore = structuredLogger.info;
    structuredLogger.info = logSpy as any;
    try {
      recordConsensusModelComparison({
        traceId: 't1', symbol: 'AAPL', legacyDecision: 'HOLD', legacyApproved: false, legacyConfidence: 0.3,
        threshold: 0.75, shadow: shadow({ finalDecision: 'HOLD', aggregateConfidence: 0.3 }),
      });
      expect(logSpy).toHaveBeenCalled();
      const payload = logSpy.mock.calls[0][1];
      expect(payload.agree).toBe(true);
    } finally {
      structuredLogger.info = restore;
    }
  });

  it('marks agree=false when legacy rejects but shadow would approve (the real SPY/NVDA-style divergence)', async () => {
    const logSpy = vi.fn();
    const { structuredLogger } = await import('../observability/StructuredLogger');
    const restore = structuredLogger.info;
    structuredLogger.info = logSpy as any;
    try {
      recordConsensusModelComparison({
        traceId: 't2', symbol: 'NVDA', legacyDecision: 'HOLD', legacyApproved: false, legacyConfidence: 0.17,
        threshold: 0.75, shadow: shadow({ finalDecision: 'BUY', aggregateConfidence: 0.8, bullishEvidence: 0.8 }),
      });
      const payload = logSpy.mock.calls[0][1];
      expect(payload.agree).toBe(false);
      expect(payload.shadowApproved).toBe(true);
      expect(payload.legacyApproved).toBe(false);
    } finally {
      structuredLogger.info = restore;
    }
  });

  it('marks agree=true when both legacy and shadow approve the same side', async () => {
    const logSpy = vi.fn();
    const { structuredLogger } = await import('../observability/StructuredLogger');
    const restore = structuredLogger.info;
    structuredLogger.info = logSpy as any;
    try {
      recordConsensusModelComparison({
        traceId: 't3', symbol: 'SPY', legacyDecision: 'BUY', legacyApproved: true, legacyConfidence: 0.8,
        threshold: 0.75, shadow: shadow({ finalDecision: 'BUY', aggregateConfidence: 0.82, bullishEvidence: 0.82 }),
      });
      const payload = logSpy.mock.calls[0][1];
      expect(payload.agree).toBe(true);
    } finally {
      structuredLogger.info = restore;
    }
  });

  it('never throws even if structuredLogger itself throws', async () => {
    const { structuredLogger } = await import('../observability/StructuredLogger');
    const restore = structuredLogger.info;
    structuredLogger.info = (() => { throw new Error('boom'); }) as any;
    try {
      expect(() => recordConsensusModelComparison({
        traceId: 't4', symbol: 'AAPL', legacyDecision: 'HOLD', legacyApproved: false, legacyConfidence: 0.3,
        threshold: 0.75, shadow: shadow({}),
      })).not.toThrow();
    } finally {
      structuredLogger.info = restore;
    }
  });
});
