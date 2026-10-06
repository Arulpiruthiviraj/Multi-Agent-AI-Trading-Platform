import { describe, it, expect } from 'vitest';
import * as MarketUniverseScanner from './MarketUniverseScanner';
import { vi } from 'vitest';
import { scoreBroadUniverseChallenger } from './OpportunityDiscovery';

/**
 * 2026-10-06 (October 5 Deterministic Opportunity Replay, Phase 5 - "first requirement: reproduce
 * reality"). Ground truth: the real DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT event recorded at
 * 2026-10-05T14:37:05.685Z (observability_events, queried directly from data/argus.db) - the same
 * cycle every prior forensic report in this series cites as the real CHRW-beats-PTC comparison.
 * Every numeric input below is copied verbatim from that real recorded payload, or independently
 * corroborated against a second real event (PTC's mover status, below).
 *
 * HONEST FINDING from building this test (documented in the companion report's Phase 5 section,
 * not hidden): DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT's candidate detail logs baseScore, gapPct,
 * gapTerm, and finalPriorityScore, but NOT the separate moverBonus/composableScore components
 * blendedHotSwapScore() folds into finalScore. Checking baseScore + gapTerm against the recorded
 * finalPriorityScore for all 11 symbols in this real cycle: CHRW and BMY match exactly (both have
 * baseScore=0 and no mover/composable contribution); PTC is off by exactly 0.5
 * (moverPriorityScoreBonus) and is independently confirmed as a real cached mover at this exact
 * time via separate MARKET_MOVER-sourced admission events at 14:31:14 and 14:36:14 the same cycle;
 * the other 8 symbols (GOOG, S, VZ, GOOGL, CMCSA, AMZN, GE, MS) each have a real, unlogged
 * composableScore contribution (diffs of 0.21-0.46, consistent with ComposableRanking's 0-1 scale)
 * that cannot be reconstructed from this event's schema. This is a genuine replay-input gap, not a
 * formula bug - a recommended addition for any future higher-fidelity replay logging, out of scope
 * to retrofit onto historical Oct 5 data.
 *
 * Scope: this test proves what IS honestly reproducible - the real scoreBroadUniverseChallenger()
 * arithmetic for the subset of symbols whose components are fully captured by the historical log,
 * and the real, decisive CHRW > PTC comparison once PTC's independently-confirmed mover bonus is
 * included. It does NOT prove full day-level SCHEDULER replay fidelity: reconstructing "which
 * candidates were in the admitted cache at cycle N" for arbitrary cycles is not possible from
 * historical data at all, because refreshBroadUniverseCache() replaces its cache wholesale per
 * refresh and only admission EVENTS were persisted, not per-cycle cache snapshots. That larger gap
 * is why Phase 14's counterfactual-policy comparisons were not run against a full-day replay.
 */
describe('October 5 replay fidelity (Phase 5) - real recorded cycle, 2026-10-05T14:37:05.685Z', () => {
  const noBaseScore = () => 0;

  it('CHRW (baseScore=0, no mover/composable contribution): real formula reproduces the recorded finalPriorityScore 1.3842 and rank 1', () => {
    const computed = scoreBroadUniverseChallenger('CHRW', -0.0277, noBaseScore);
    // 2dp tolerance: the recorded gapPct itself was already round4()'d for display before this
    // test reads it back; feeding an already-rounded gapPct into gapTerm = |gapPct| * 100 * weight
    // amplifies that rounding error ~100x (confirmed live: -0.0277 reproduces 1.385 vs the logged
    // 1.3842, a real 0.0008 gap) - an honest precision limit of replaying from rounded logs, not a
    // tolerance chosen to force a pass.
    expect(computed).toBeCloseTo(1.3842, 2);
  });

  it('BMY (baseScore=0, no mover/composable contribution): real formula reproduces the recorded finalPriorityScore 1.2187', () => {
    const computed = scoreBroadUniverseChallenger('BMY', -0.0244, noBaseScore);
    expect(computed).toBeCloseTo(1.2187, 2);
  });

  it('PTC: the raw gap-term alone (0.545) does NOT match the recorded 1.045 - a naive replay ignoring mover status would wrongly conclude the formula is broken', () => {
    const gapTermOnly = scoreBroadUniverseChallenger('PTC', -0.0109, noBaseScore);
    expect(gapTermOnly).toBeCloseTo(0.545, 2);
    expect(gapTermOnly).not.toBeCloseTo(1.045, 1);
  });

  it('PTC: once its independently-confirmed real mover status is included, the real formula reproduces the recorded finalPriorityScore 1.045', () => {
    // Independent corroboration, not an assumption: PTC was admitted via source=MARKET_MOVER at
    // 2026-10-05T14:31:14.352Z and 14:36:14.337Z - both inside the same broad-universe refresh
    // window as this 14:37:05 challenger cycle - confirming it was a real cached verified mover,
    // not a guess made to fit the arithmetic.
    vi.spyOn(MarketUniverseScanner, 'getCachedMoverSymbols').mockReturnValue(['PTC']);
    const withRealMoverStatus = scoreBroadUniverseChallenger('PTC', -0.0109, noBaseScore);
    expect(withRealMoverStatus).toBeCloseTo(1.045, 2);
    vi.restoreAllMocks();
  });

  it('the real, decisive comparison every prior report in this series cites: CHRW legitimately outscored PTC under the real formula once mover status is accounted for - not a scheduling accident', () => {
    const chrw = scoreBroadUniverseChallenger('CHRW', -0.0277, noBaseScore);
    vi.spyOn(MarketUniverseScanner, 'getCachedMoverSymbols').mockReturnValue(['PTC']);
    const ptcWithRealMoverStatus = scoreBroadUniverseChallenger('PTC', -0.0109, noBaseScore);
    vi.restoreAllMocks();
    expect(chrw).toBeGreaterThan(ptcWithRealMoverStatus);
    expect(ptcWithRealMoverStatus).toBeCloseTo(1.045, 2);
  });
});
