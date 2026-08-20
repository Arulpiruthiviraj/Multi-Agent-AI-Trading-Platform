import { describe, it, expect } from 'vitest';
import { replayArgusStrategy } from './argusStrategyReplay';
import { loadGoldenReplayDataset } from '../replay/loadGoldenReplayDataset';

describe('replayArgusStrategy onlyLatestBar (O(N^3) replay performance fix)', () => {
  it('onlyLatestBar:true returns exactly one signal, matching the full-history call\'s last signal', () => {
    const ds = loadGoldenReplayDataset();
    const strategyId = 'MOMENTUM_BREAKOUT';

    const full = replayArgusStrategy({ strategyId, bars: ds.bars, provenance: ds.provenance ?? 'UNIT_FIXTURE' });
    const latestOnly = replayArgusStrategy({ strategyId, bars: ds.bars, provenance: ds.provenance ?? 'UNIT_FIXTURE', onlyLatestBar: true });

    expect(full.barCount).toBe(ds.bars.length);
    expect(latestOnly.barCount).toBe(ds.bars.length);
    // Full history evaluates every bar-endpoint from MIN_BARS onward (minConfidence defaults to 0,
    // so every endpoint pushes a signal); onlyLatestBar evaluates exactly one endpoint.
    expect(full.signals.length).toBeGreaterThan(1);
    expect(latestOnly.signals.length).toBe(1);

    const lastFullSignal = full.signals[full.signals.length - 1];
    const onlySignal = latestOnly.signals[0];
    expect(onlySignal.timestamp).toBe(lastFullSignal.timestamp);
    expect(onlySignal.side).toBe(lastFullSignal.side);
    expect(onlySignal.confidence).toBe(lastFullSignal.confidence);
    expect(onlySignal.stop).toBe(lastFullSignal.stop);
    expect(onlySignal.target).toBe(lastFullSignal.target);
    expect(onlySignal.entryRegime).toBe(lastFullSignal.entryRegime);
    expect(onlySignal.invalidationConditions).toEqual(lastFullSignal.invalidationConditions);
    expect(onlySignal.applicableRegimes).toEqual(lastFullSignal.applicableRegimes);
  });

  it('onlyLatestBar:true still returns INSUFFICIENT_SAMPLE when bars.length < MIN_BARS, exactly like the default path', () => {
    const ds = loadGoldenReplayDataset();
    const tooFew = ds.bars.slice(0, 3);

    const full = replayArgusStrategy({ strategyId: 'MOMENTUM_BREAKOUT', bars: tooFew, provenance: 'UNIT_FIXTURE' });
    const latestOnly = replayArgusStrategy({ strategyId: 'MOMENTUM_BREAKOUT', bars: tooFew, provenance: 'UNIT_FIXTURE', onlyLatestBar: true });

    expect(full.rejection).toBe('INSUFFICIENT_SAMPLE');
    expect(latestOnly.rejection).toBe('INSUFFICIENT_SAMPLE');
    expect(latestOnly.signals).toEqual([]);
  });

  it('onlyLatestBar defaults to false/full-history behavior when omitted (existing callers unaffected)', () => {
    const ds = loadGoldenReplayDataset();
    const withoutFlag = replayArgusStrategy({ strategyId: 'MOMENTUM_BREAKOUT', bars: ds.bars, provenance: ds.provenance ?? 'UNIT_FIXTURE' });
    const explicitFalse = replayArgusStrategy({ strategyId: 'MOMENTUM_BREAKOUT', bars: ds.bars, provenance: ds.provenance ?? 'UNIT_FIXTURE', onlyLatestBar: false });
    expect(withoutFlag.signals.length).toBe(explicitFalse.signals.length);
    expect(withoutFlag.signals.length).toBeGreaterThan(1);
  });
});
