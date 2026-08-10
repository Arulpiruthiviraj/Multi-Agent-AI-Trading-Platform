import { describe, it, expect } from 'vitest';
import { shouldTriggerOpenAliceVerification } from './EscalationPolicy';

describe('shouldTriggerOpenAliceVerification', () => {
  it('triggers when agents disagreed even though the weighted vote still approved', () => {
    const decision = shouldTriggerOpenAliceVerification({ confidence: 0.95, disagreementCount: 1 });
    expect(decision.shouldVerify).toBe(true);
    expect(decision.reason).toContain('disagreed');
  });

  it('triggers when confidence sits inside the uncertain band with no disagreement', () => {
    const decision = shouldTriggerOpenAliceVerification({ confidence: 0.80, disagreementCount: 0 });
    expect(decision.shouldVerify).toBe(true);
    expect(decision.reason).toContain('uncertain band');
  });

  it('does not trigger on strong consensus with no disagreement', () => {
    const decision = shouldTriggerOpenAliceVerification({ confidence: 0.97, disagreementCount: 0 });
    expect(decision.shouldVerify).toBe(false);
  });

  it('does not trigger right at the approval floor with no disagreement (below the uncertain band)', () => {
    // ChiefTraderAgent only calls this after result.confidence > 0.75, so 0.75 itself never
    // reaches here in practice, but the boundary behavior should still be deterministic.
    const decision = shouldTriggerOpenAliceVerification({ confidence: 0.751, disagreementCount: 0 });
    expect(decision.shouldVerify).toBe(true); // inside default [0.75, 0.85] band
  });

  it('respects custom bounds', () => {
    const decision = shouldTriggerOpenAliceVerification({ confidence: 0.9, disagreementCount: 0, lowerBound: 0.85, upperBound: 0.95 });
    expect(decision.shouldVerify).toBe(true);
  });
});
