import { describe, it, expect } from 'vitest';
import { resolveEvaluationDueMs, type HorizonDurations } from './NewsPredictionEvaluation';

const DURATIONS: HorizonDurations = {
  intradayMs: 4 * 60 * 60 * 1000,
  shortTermMs: 2 * 24 * 60 * 60 * 1000,
  mediumTermMs: 7 * 24 * 60 * 60 * 1000,
  longerTermMs: 30 * 24 * 60 * 60 * 1000,
};

describe('resolveEvaluationDueMs', () => {
  it('maps every real horizon to its configured duration', () => {
    expect(resolveEvaluationDueMs('INTRADAY', DURATIONS)).toBe(DURATIONS.intradayMs);
    expect(resolveEvaluationDueMs('SHORT_TERM', DURATIONS)).toBe(DURATIONS.shortTermMs);
    expect(resolveEvaluationDueMs('MEDIUM_TERM', DURATIONS)).toBe(DURATIONS.mediumTermMs);
    expect(resolveEvaluationDueMs('LONGER_TERM', DURATIONS)).toBe(DURATIONS.longerTermMs);
  });
  it('UNKNOWN falls back to the short-term window rather than guessing an extreme', () => {
    expect(resolveEvaluationDueMs('UNKNOWN', DURATIONS)).toBe(DURATIONS.shortTermMs);
  });
});
