import { describe, it, expect } from 'vitest';
import { runtimeIntervals } from './runtimeIntervals';
import { quantThresholds } from './quantThresholds';
import { tradingSafety } from './tradingSafety';
import { loadRepoConfigJson } from './loadRepoConfigJson';

describe('externalized runtime/quant config', () => {
  it('loads the same runtimeIntervals.json production uses', () => {
    const raw = loadRepoConfigJson<typeof runtimeIntervals>('runtimeIntervals.json');
    expect(runtimeIntervals.macroAgentMs).toBe(raw.macroAgentMs);
    expect(runtimeIntervals.omsFollowUpMinAgeMs).toBe(raw.omsFollowUpMinAgeMs);
    expect(runtimeIntervals.rssFeedErrorBackoffMs).toBe(raw.rssFeedErrorBackoffMs);
    expect(runtimeIntervals.rssFeedFetchTimeoutMs).toBe(raw.rssFeedFetchTimeoutMs);
  });

  it('loads the same quantThresholds.json production uses', () => {
    const raw = loadRepoConfigJson<typeof quantThresholds>('quantThresholds.json');
    expect(quantThresholds.rsiOverbought).toBe(raw.rsiOverbought);
    expect(quantThresholds.groupedScoreWeights.trend).toBe(raw.groupedScoreWeights.trend);
  });

  it('tradingSafety sample-size and recon keys are finite', () => {
    expect(tradingSafety.minSampleSizeForTrust).toBeGreaterThan(0);
    expect(tradingSafety.reconSignificantMismatchDollars).toBeGreaterThan(0);
    expect(tradingSafety.evaluationHorizonMs).toBeGreaterThan(0);
  });
});
