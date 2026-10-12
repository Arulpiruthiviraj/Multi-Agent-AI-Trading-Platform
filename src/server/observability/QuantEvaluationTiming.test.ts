// LABEL: UNIT
import { describe, expect, it } from 'vitest';
import { QuantEvaluationTiming, quantEvaluationErrorKind } from './QuantEvaluationTiming';

describe('Quant evaluation stage attribution', () => {
  it('attributes a slow market-context wait separately from warm strategy computation', () => {
    let now = 100;
    const timing = new QuantEvaluationTiming(() => now);
    now += 11; timing.enter('MARKET_CONTEXT');
    now += 300_000; timing.enter('STRATEGIES');
    now += 12; timing.enter('PERSISTENCE');
    now += 4;
    const result = timing.snapshot();
    expect(result.stageDurationsMs).toEqual({ PRIMARY_BARS: 11, MARKET_CONTEXT: 300_000, STRATEGIES: 12, PERSISTENCE: 4 });
    expect(result.durationMs).toBe(300_027);
    expect(result.timingScope).toBe('ELAPSED_INCLUDING_AWAIT_AND_HOST_STALLS');
  });
  it('snapshots do not double count and calls do not share timing state', () => {
    let now = 0;
    const first = new QuantEvaluationTiming(() => now);
    now = 8;
    const second = new QuantEvaluationTiming(() => now);
    expect(first.snapshot().durationMs).toBe(8);
    expect(first.snapshot().durationMs).toBe(8);
    expect(second.snapshot().durationMs).toBe(0);
  });
  it('classifies a coalesced caller timeout without persisting sensitive error text', () => {
    const error = new Error('COALESCE_CALLER_TIMEOUT provider token=secret account=private');
    expect(quantEvaluationErrorKind(error)).toBe('COALESCE_CALLER_TIMEOUT');
    expect(quantEvaluationErrorKind(new Error('private response body'))).toBe('UNCLASSIFIED_ERROR');
    expect(quantEvaluationErrorKind({ get message() { throw new Error('bad error object'); } })).toBe('UNCLASSIFIED_ERROR');
  });
});
