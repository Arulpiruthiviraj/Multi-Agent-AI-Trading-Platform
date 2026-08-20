/**
 * Historical discovery for ARGUS_DISCOVERY replay mode. Pure/unit-testable functions only - no
 * EventBus, RiskEngine, OrderManagement, or BrokerManager imports (matches the extension-zone
 * discipline of src/server/continuous/). This does NOT reproduce a true point-in-time market
 * listing: `historicalDiscoveryUniverse` in config/replaySafety.json is a static, curated proxy
 * list of liquid large-caps/ETFs, carrying the same survivorship bias as today's index
 * membership - see `replaySafety.historicalDiscoveryFidelityWarning`, surfaced in every replay
 * report run in ARGUS_DISCOVERY mode so this limitation is never silently hidden.
 *
 * The screening step itself IS point-in-time correct: it only ever reads bars with
 * `timestamp < t` (same cutoff discipline as ReplayContext.replayVisibleBars), so which symbols
 * are "active" at a given historical moment is derived solely from information available then,
 * not from today's liquidity.
 */
import type { ResearchBar } from '../research/ohlcvTypes';
import {
  getHistoricalDiscoveryUniverse,
  rankCandidatesByDollarVolume,
  type RankedCandidate,
} from './replayDiscoveryAdapter';

export { getHistoricalDiscoveryUniverse };
export type { RankedCandidate as ScreenedCandidate };

/**
 * Point-in-time liquidity screen. Delegates to shared rankCandidatesByDollarVolume.
 */
export function screenHistoricalCandidates(
  candidates: string[],
  barsBySymbol: Map<string, ResearchBar[]>,
  t: number,
  opts: { lookbackBars: number; minDollarVolume: number; maxActive: number },
): RankedCandidate[] {
  return rankCandidatesByDollarVolume(
    { asOfMs: t, barsBySymbol, candidatePool: candidates },
    opts,
  );
}
