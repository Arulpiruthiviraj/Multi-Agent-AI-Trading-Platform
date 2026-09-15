/**
 * Synthetic Market Session Simulator (2026-09-14 mandate), Phase 3 + 5 + 6: dynamic synthetic
 * OHLCV bar generation, deterministic given (seed, symbol config, scenario). Builds real,
 * non-repeating price paths from log-returns (a random walk with regime-dependent drift/vol, not a
 * replayed fixed candle sequence) - includes bid/ask/spread, volume, and a real point-in-time
 * causality guarantee: generateSession() returns ALL bars up front (deterministic given the seed),
 * but SyntheticSessionEngine.ts only ever reveals bars whose timestamp has already been reached by
 * the simulated clock - see that file for the point-in-time-safe consumption pattern (mirrors
 * ReplayContext.ts's replayVisibleBars() strict-prefix rule).
 */
import { SyntheticRandom } from './SyntheticRandom';
import { activeSegment, type ScenarioProfile } from './SyntheticScenario';

export interface SyntheticBar {
  symbol: string;
  timestamp: number; // bar open time, ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bid: number;
  ask: number;
  spread: number;
}

export interface SyntheticSymbolConfig {
  symbol: string;
  startPrice: number;
  /** Per-bar stdev of log-returns under baseline (regime multiplier 1.0) conditions. */
  baseVolatility: number;
  baseVolumePerBar: number;
  /** Base bid/ask spread as a fraction of price under normal liquidity. */
  baseSpreadPct: number;
}

const DEFAULT_UNIVERSE: SyntheticSymbolConfig[] = [
  { symbol: 'SPY', startPrice: 560, baseVolatility: 0.0006, baseVolumePerBar: 400_000, baseSpreadPct: 0.0001 },
  { symbol: 'QQQ', startPrice: 480, baseVolatility: 0.0007, baseVolumePerBar: 350_000, baseSpreadPct: 0.0001 },
  { symbol: 'AAPL', startPrice: 230, baseVolatility: 0.0009, baseVolumePerBar: 90_000, baseSpreadPct: 0.0002 },
  { symbol: 'MSFT', startPrice: 430, baseVolatility: 0.0008, baseVolumePerBar: 60_000, baseSpreadPct: 0.0002 },
  { symbol: 'NVDA', startPrice: 130, baseVolatility: 0.0014, baseVolumePerBar: 250_000, baseSpreadPct: 0.0003 },
  { symbol: 'AMD', startPrice: 155, baseVolatility: 0.0013, baseVolumePerBar: 110_000, baseSpreadPct: 0.0003 },
  { symbol: 'AMZN', startPrice: 190, baseVolatility: 0.0010, baseVolumePerBar: 80_000, baseSpreadPct: 0.0002 },
  { symbol: 'META', startPrice: 520, baseVolatility: 0.0011, baseVolumePerBar: 55_000, baseSpreadPct: 0.0002 },
  { symbol: 'TSLA', startPrice: 240, baseVolatility: 0.0018, baseVolumePerBar: 140_000, baseSpreadPct: 0.0004 },
  { symbol: 'GOOGL', startPrice: 175, baseVolatility: 0.0009, baseVolumePerBar: 70_000, baseSpreadPct: 0.0002 },
];

export function defaultSyntheticUniverse(size = 10): SyntheticSymbolConfig[] {
  return DEFAULT_UNIVERSE.slice(0, Math.max(1, Math.min(size, DEFAULT_UNIVERSE.length)));
}

const BAR_INTERVAL_MS = 60_000;

/** Opening-5-minutes and closing-15-minutes volume/volatility multiplier, layered on top of the
 *  scenario's own regime multipliers - real intraday U-shaped volume curve, independent of which
 *  scenario is active (mandate section 15: "the first 5 minutes deserve special treatment"). */
function intradayMultiplier(offsetMs: number, sessionLengthMs: number): { vol: number; volume: number } {
  const openingWindow = 5 * BAR_INTERVAL_MS;
  const closingWindow = 15 * BAR_INTERVAL_MS;
  if (offsetMs < openingWindow) {
    const frac = 1 - offsetMs / openingWindow; // 1 at open, 0 at end of window
    return { vol: 1 + frac * 0.8, volume: 1 + frac * 2.5 };
  }
  if (offsetMs > sessionLengthMs - closingWindow) {
    const frac = (offsetMs - (sessionLengthMs - closingWindow)) / closingWindow; // 0..1 into close
    return { vol: 1 + frac * 0.4, volume: 1 + frac * 1.2 };
  }
  return { vol: 1, volume: 1 };
}

export class SyntheticMarketDataEngine {
  constructor(
    private readonly rng: SyntheticRandom,
    private readonly universe: SyntheticSymbolConfig[],
    private readonly scenario: ScenarioProfile,
  ) {}

  /** Generates the FULL deterministic session for every symbol up front. This is not a look-ahead
   *  violation by itself - it is the same "known future" a real historical dataset already is;
   *  point-in-time safety is enforced by the CONSUMER only ever reading a strict timestamp prefix
   *  (see SyntheticSessionEngine.ts), exactly as replay's own HistoricalMarketDataAdapter works. */
  generateSession(startMs: number, endMs: number): Map<string, SyntheticBar[]> {
    const sessionLengthMs = endMs - startMs;
    const out = new Map<string, SyntheticBar[]>();

    for (const config of this.universe) {
      const bars: SyntheticBar[] = [];
      let price = config.startPrice;
      let volatilitySpikeRemaining = 0;
      let volatilitySpikeMultiplier = 1;
      let interruptionRemaining = 0;

      for (let t = startMs; t < endMs; t += BAR_INTERVAL_MS) {
        const offsetMs = t - startMs;
        const segment = activeSegment(this.scenario, offsetMs);
        const intraday = intradayMultiplier(offsetMs, sessionLengthMs);

        // Apply any scenario events whose moment has arrived, exactly once, at this bar.
        for (const event of this.scenario.events) {
          if (event.atOffsetMs !== offsetMs) continue;
          if (event.symbols && !event.symbols.includes(config.symbol)) continue;
          if (event.type === 'GAP' && typeof event.gapPct === 'number') {
            price = price * (1 + event.gapPct);
          }
          if (event.type === 'NEWS_SHOCK') {
            // Price/volume reaction to the news is modeled via a short volatility-spike + drift
            // burst - the actual SYNTHETIC NEWS ITEM (the thing NewsAgent perceives) is generated
            // separately by SyntheticNewsGenerator.ts from this same scenario/event definition, so
            // the price move and the news article are causally the same event, not two unrelated
            // random draws.
            const magnitude = event.newsMagnitude === 'HIGH_IMPACT' ? 0.02 : 0.006;
            const sign = event.newsDirection === 'NEGATIVE' ? -1 : 1;
            price = price * (1 + sign * magnitude);
            volatilitySpikeRemaining = 8;
            volatilitySpikeMultiplier = 2.5;
          }
          if (event.type === 'VOLATILITY_SPIKE') {
            volatilitySpikeRemaining = event.durationBars ?? 5;
            volatilitySpikeMultiplier = event.volatilityMultiplier ?? 2;
          }
          if (event.type === 'DATA_INTERRUPTION') {
            interruptionRemaining = event.interruptionBars ?? 3;
          }
        }

        if (interruptionRemaining > 0) {
          interruptionRemaining -= 1;
          continue; // no bar produced for this offset - a real, deliberate data gap
        }

        const spikeMult = volatilitySpikeRemaining > 0 ? volatilitySpikeMultiplier : 1;
        if (volatilitySpikeRemaining > 0) volatilitySpikeRemaining -= 1;

        const vol = config.baseVolatility * segment.volatilityMultiplier * intraday.vol * spikeMult;
        const driftPerBar = segment.driftPerBarMean;
        const logReturn = driftPerBar + vol * this.rng.gaussian();

        const open = price;
        const close = open * Math.exp(logReturn);
        // Real intrabar range - not just open/close, so ATR-style indicators have real signal.
        const intrabarRangeFrac = Math.abs(vol) * this.rng.range(0.8, 2.2);
        const high = Math.max(open, close) * (1 + intrabarRangeFrac * this.rng.range(0.2, 1));
        const low = Math.min(open, close) * (1 - intrabarRangeFrac * this.rng.range(0.2, 1));

        const volume = Math.max(1, Math.round(
          config.baseVolumePerBar * segment.volumeMultiplier * intraday.volume * this.rng.range(0.6, 1.5),
        ));

        const spreadPct = config.baseSpreadPct * (spikeMult > 1 ? spikeMult * 1.5 : 1) * (intraday.vol > 1 ? intraday.vol : 1);
        const mid = close;
        const spread = mid * spreadPct;
        const bid = mid - spread / 2;
        const ask = mid + spread / 2;

        bars.push({
          symbol: config.symbol,
          timestamp: t,
          open: round2(open), high: round2(high), low: round2(low), close: round2(close),
          volume,
          bid: round2(bid), ask: round2(ask), spread: round2(spread),
        });

        price = close;
      }

      out.set(config.symbol, bars);
    }

    return out;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
