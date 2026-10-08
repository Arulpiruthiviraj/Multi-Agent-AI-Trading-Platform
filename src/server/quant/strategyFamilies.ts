/**
 * Real strategy-family classification (2026-09-09, QuantEngine internal-ensemble independent
 * qualification - see ChiefTraderAgent.ts's own doc comment on
 * isQuantIndependentQualificationEnabled). Reuses config/quantMasterTaxonomy.json's existing
 * 10-family catalog rather than inventing new family names - one source of truth for what a
 * "family" is in this codebase.
 *
 * Honest note: the 5 CORE TypeScript strategies are each regime-scoped
 * (applicableRegimes - momentumBreakout/pullbackContinuation/trendFollowing only fire in
 * BULLISH_TREND/BEARISH_TREND; meanReversion/rangeReversion only fire in SIDEWAYS_RANGE), so in
 * any single evaluation cycle at most a handful of them can produce a non-HOLD signal
 * simultaneously, and they cluster into essentially 2 real families (trend/breakout vs mean
 * reversion). Genuine multi-family diversity for the independent-qualification bar realistically
 * requires the newly-HTTP-wired Java RESEARCH engines (rsi_mean_reversion, macd_crossover,
 * bollinger_mean_reversion, moving_average_crossover, donchian_channel, trend_strength_adx,
 * mean_reversion_zscore, stochastic_oscillator, time_series_momentum, volume_signal) to also
 * contribute votes - see QuantSignalAgent.ts's buildInternalEnsembleVotes(). This file does not
 * paper over that; it classifies honestly, so the effectiveIndependentCount/family-count
 * computation reflects real diversity, not inflated diversity.
 */

export type QuantFamilyId =
  | 'TREND_MOMENTUM'
  | 'MEAN_REVERSION_FAMILY'
  | 'BREAKOUT_VOLATILITY'
  | 'MARKET_STRUCTURE_FLOW'
  | 'STATISTICAL_ARBITRAGE';

/** CORE TS strategy id -> family, per each strategy's own real entry logic (see the QuantEngine
 *  Expansion design doc's §1.2 audit table for the reasoning behind each mapping). */
const CORE_STRATEGY_FAMILIES: Record<string, QuantFamilyId> = {
  MOMENTUM_BREAKOUT: 'BREAKOUT_VOLATILITY',
  PULLBACK_CONTINUATION: 'TREND_MOMENTUM',
  MEAN_REVERSION: 'MEAN_REVERSION_FAMILY',
  TREND_FOLLOWING: 'TREND_MOMENTUM',
  RANGE_REVERSION: 'MEAN_REVERSION_FAMILY',
};

/** Experimental TS strategy id -> family, for the ones with an unambiguous single family. */
const EXPERIMENTAL_STRATEGY_FAMILIES: Record<string, QuantFamilyId> = {
  SMC_LIQUIDITY_SWEEP: 'MARKET_STRUCTURE_FLOW',
  VWAP_VOLUME_STRUCTURE: 'MARKET_STRUCTURE_FLOW',
  OPENING_RANGE_BREAKOUT: 'BREAKOUT_VOLATILITY',
  VWAP_MEAN_REVERSION: 'MEAN_REVERSION_FAMILY',
  DONCHIAN_CHANNEL_BREAKOUT: 'BREAKOUT_VOLATILITY',
  MA_CROSSOVER: 'TREND_MOMENTUM',
  OSCILLATOR_MOMENTUM: 'TREND_MOMENTUM',
  BOLLINGER_VOLATILITY: 'BREAKOUT_VOLATILITY',
  PREVIOUS_PERIOD_BREAKOUT: 'BREAKOUT_VOLATILITY',
  CANDLESTICK_REVERSAL: 'MARKET_STRUCTURE_FLOW',
  GAP_CONTINUATION: 'BREAKOUT_VOLATILITY',
  FIBONACCI_PULLBACK: 'TREND_MOMENTUM',
  VOLUME_CONFIRMATION: 'MARKET_STRUCTURE_FLOW',
  SR_BOUNCE: 'MEAN_REVERSION_FAMILY',
  RELATIVE_STRENGTH_ROTATION: 'TREND_MOMENTUM',
  STATISTICAL_MEAN_REVERSION: 'STATISTICAL_ARBITRAGE',
};

/** Java RESEARCH engine strategyId (config/engineOwnership.json keys) -> family. */
const JAVA_RESEARCH_STRATEGY_FAMILIES: Record<string, QuantFamilyId> = {
  rsi_mean_reversion: 'MEAN_REVERSION_FAMILY',
  macd_crossover: 'TREND_MOMENTUM',
  bollinger_mean_reversion: 'MEAN_REVERSION_FAMILY',
  moving_average_crossover: 'TREND_MOMENTUM',
  donchian_channel: 'BREAKOUT_VOLATILITY',
  trend_strength_adx: 'TREND_MOMENTUM',
  mean_reversion_zscore: 'MEAN_REVERSION_FAMILY',
  stochastic_oscillator: 'MEAN_REVERSION_FAMILY',
  time_series_momentum: 'TREND_MOMENTUM',
  volume_signal: 'MARKET_STRUCTURE_FLOW',
  // 2026-10-05: institutional signal strategies (StrategyRegistry.INSTITUTIONAL).
  // The three momentum strategies are wired to paper verification via
  // InstitutionalStrategyVoteService (per-strategy vote flags); STAT_ARB is
  // research-only (needs pair universe + short-selling).
  INSTITUTIONAL_VOL_SCALED_MTF_MOMENTUM: 'TREND_MOMENTUM',
  INSTITUTIONAL_TS_MOMENTUM_12M: 'TREND_MOMENTUM',
  INSTITUTIONAL_MULTI_FACTOR_MOMENTUM: 'TREND_MOMENTUM',
  INSTITUTIONAL_STAT_ARB: 'STATISTICAL_ARBITRAGE',
};

/**
 * 2026-10-05: per-strategy vote env vars for institutional strategies wired to paper
 * verification. A strategy listed here is vote-eligible only when BOTH the Java bridge
 * (QUANT_JAVA_CORE_ENABLED) and its own vote flag are on. Strategies absent from this
 * map (e.g. INSTITUTIONAL_STAT_ARB) are research-only - reachable over HTTP, no votes.
 */
export const INSTITUTIONAL_VOTE_ENV_VARS: Record<string, string> = {
  INSTITUTIONAL_VOL_SCALED_MTF_MOMENTUM: 'ARGUS_VOL_SCALED_MTF_MOMENTUM_VOTE_ENABLED',
  INSTITUTIONAL_TS_MOMENTUM_12M: 'ARGUS_TS_MOMENTUM_12M_VOTE_ENABLED',
  INSTITUTIONAL_MULTI_FACTOR_MOMENTUM: 'ARGUS_MULTI_FACTOR_MOMENTUM_VOTE_ENABLED',
};

/** Returns null (never a guessed family) for an id this map doesn't recognize. */
export function familyForStrategyId(strategyId: string): QuantFamilyId | null {
  return (
    CORE_STRATEGY_FAMILIES[strategyId]
    ?? EXPERIMENTAL_STRATEGY_FAMILIES[strategyId]
    ?? JAVA_RESEARCH_STRATEGY_FAMILIES[strategyId]
    ?? null
  );
}

/** All Java RESEARCH strategyIds this codebase currently knows how to HTTP-evaluate for a
 *  symbol's internal ensemble (see QuantCoreServer.java's evaluateResearchStrategy() switch). */
export const JAVA_RESEARCH_STRATEGY_IDS: string[] = Object.keys(JAVA_RESEARCH_STRATEGY_FAMILIES);

/**
 * 2026-10-07 (strategy-layer audit D5): the subset of JAVA_RESEARCH_STRATEGY_IDS that
 * javaResultToVote() (internalQuantEnsemble.ts) actually maps to a vote. The 4 INSTITUTIONAL_*
 * ids are family-classified above (honest classification for the correlation math) but return
 * null in the vote mapper's default case - they have no vote mapping (wired to paper
 * verification via InstitutionalStrategyVoteService's own per-strategy vote flags, or
 * research-only like INSTITUTIONAL_STAT_ARB). The per-symbol/per-cycle Java HTTP fan-out MUST
 * use THIS list, never JAVA_RESEARCH_STRATEGY_IDS, or every cycle fires 4 wasted HTTP calls
 * whose results are unconditionally discarded. Listed explicitly (not derived from the switch)
 * so a future mapper case added without updating this list fails loudly in the fanout test
 * below instead of silently re-wasting calls.
 */
export const VOTABLE_JAVA_RESEARCH_STRATEGY_IDS: string[] = [
  'rsi_mean_reversion',
  'macd_crossover',
  'bollinger_mean_reversion',
  'moving_average_crossover',
  'donchian_channel',
  'trend_strength_adx',
  'mean_reversion_zscore',
  'stochastic_oscillator',
  'time_series_momentum',
  'volume_signal',
];
