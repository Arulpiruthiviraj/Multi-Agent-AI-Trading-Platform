/**
 * Historical discovery adapters — shared ranking logic, environment-specific data acquisition.
 *
 * LIVE path (not invoked here):
 *   MarketDataWorker → OpportunityDiscovery / OpportunityScreener / MarketUniverseScanner
 *
 * REPLAY path:
 *   HistoricalMarketDataAdapter (PIT bars) → rankCandidatesByDollarVolume → HistoricalUniverseAdapter
 */
import type { ResearchBar } from '../research/ohlcvTypes';
import { replaySafety } from './replaySafety';

export interface HistoricalOpportunityContext {
  /** Historical clock ms — only bars strictly before this timestamp are visible. */
  asOfMs: number;
  barsBySymbol: Map<string, ResearchBar[]>;
  candidatePool: string[];
}

export interface RankedCandidate {
  symbol: string;
  avgDollarVolume: number;
}

export interface DollarVolumeRankOpts {
  lookbackBars: number;
  minDollarVolume: number;
  maxActive: number;
}

/**
 * Shared deterministic liquidity ranker. Used by HistoricalUniverseProvider (replay) and
 * documented as the replay-side analogue of live dollar-volume screening — not live modules.
 */
export function rankCandidatesByDollarVolume(
  ctx: HistoricalOpportunityContext,
  opts: DollarVolumeRankOpts,
): RankedCandidate[] {
  const scored: RankedCandidate[] = [];
  const t = ctx.asOfMs;
  for (const symbol of ctx.candidatePool) {
    const bars = ctx.barsBySymbol.get(symbol.toUpperCase()) || [];
    const visible = bars.filter((b) => b.timestamp < t);
    if (visible.length < opts.lookbackBars) continue;
    const window = visible.slice(-opts.lookbackBars);
    const avgDollarVolume = window.reduce((sum, b) => sum + b.close * b.volume, 0) / window.length;
    if (avgDollarVolume < opts.minDollarVolume) continue;
    scored.push({ symbol, avgDollarVolume });
  }
  return scored
    .sort((a, b) => b.avgDollarVolume - a.avgDollarVolume)
    .slice(0, opts.maxActive);
}

export function defaultDiscoveryRankOpts(): DollarVolumeRankOpts {
  return {
    lookbackBars: replaySafety.historicalDiscoveryLookbackBars,
    minDollarVolume: replaySafety.historicalDiscoveryMinDollarVolume,
    maxActive: replaySafety.historicalDiscoveryMaxActiveCandidates,
  };
}

/** Replay-side adapter: PIT screen over a static candidate pool. */
export function screenHistoricalUniverse(
  ctx: HistoricalOpportunityContext,
  opts: DollarVolumeRankOpts = defaultDiscoveryRankOpts(),
): RankedCandidate[] {
  return rankCandidatesByDollarVolume(ctx, opts);
}

export function getHistoricalDiscoveryUniverse(): string[] {
  return [...replaySafety.historicalDiscoveryUniverse];
}
