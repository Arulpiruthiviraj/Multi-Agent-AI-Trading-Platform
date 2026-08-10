import { describe, it, expect } from 'vitest';
import { decideEscalation } from './EscalationPolicy';

describe('decideEscalation', () => {
  it('escalates when no local signal is available at all', () => {
    const result = decideEscalation({ localSource: 'finbert', localSignalAvailable: false, localConfidence: 0.9, decisiveThreshold: 0.6 });
    expect(result.escalate).toBe(true);
    expect(result.reason).toMatch(/unavailable/);
  });

  it('does not escalate when local confidence meets the threshold exactly', () => {
    const result = decideEscalation({ localSource: 'finbert', localSignalAvailable: true, localConfidence: 0.6, decisiveThreshold: 0.6 });
    expect(result.escalate).toBe(false);
    expect(result.reason).toMatch(/decisive/);
  });

  it('does not escalate when local confidence clears the threshold', () => {
    const result = decideEscalation({ localSource: 'finbert', localSignalAvailable: true, localConfidence: 0.85, decisiveThreshold: 0.6 });
    expect(result.escalate).toBe(false);
  });

  it('escalates when local confidence is below the threshold', () => {
    const result = decideEscalation({ localSource: 'finbert', localSignalAvailable: true, localConfidence: 0.4, decisiveThreshold: 0.6 });
    expect(result.escalate).toBe(true);
    expect(result.reason).toMatch(/inconclusive/);
  });

  it('always returns a human-readable reason naming the local source', () => {
    const result = decideEscalation({ localSource: 'xgboost_direction', localSignalAvailable: true, localConfidence: 0.1, decisiveThreshold: 0.6 });
    expect(result.reason).toContain('xgboost_direction');
  });
});
