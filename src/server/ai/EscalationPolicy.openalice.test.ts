import { describe, it, expect } from 'vitest';
import { shouldTriggerOpenAliceVerification } from './EscalationPolicy';
import { tradingSafety } from '../config/tradingSafety';

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
    const justInsideBand = tradingSafety.openAliceUncertainBandLow + 0.001;
    const decision = shouldTriggerOpenAliceVerification({ confidence: justInsideBand, disagreementCount: 0 });
    expect(decision.shouldVerify).toBe(true);
  });

  it('respects custom bounds', () => {
    const decision = shouldTriggerOpenAliceVerification({ confidence: 0.9, disagreementCount: 0, lowerBound: 0.85, upperBound: 0.95 });
    expect(decision.shouldVerify).toBe(true);
  });
});
