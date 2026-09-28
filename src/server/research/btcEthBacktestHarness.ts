/**
 * BTC/ETH causal per-bar research harness (2026-09-27, ARGUS Crypto Quant Alpha follow-up).
 *
 * Purpose: run the REAL, existing Java crypto strategies (`BtcAdaptiveVolatilityMomentumStrategy`,
 * `BtcAdaptiveBollingerMeanReversionStrategy` - quant-core-java/.../institutional/models/) against
 * REAL historical `ohlcv_bars` rows, bar by bar, with zero lookahead: at bar i the harness calls the
 * Java engine with only `bars[0..i]`, exactly what would have been known at that point in time.
 *
 * This module is pure research plumbing:
 *  - It never imports OrderManagement/OMS, the live RiskEngine, ChiefTraderAgent, BrokerManager, or
 *    PositionSizing.
 *  - It never calls the broker order-submission method or the trade-idea event emitter.
 *  - It never places a real or paper order - it only computes a hypothetical fill sequence and
 *    hands back metrics for a caller (the standalone script `scripts/run_btc_eth_backtest.ts`) to
 *    persist as a `quant_strategy_backtests` row.
 *
 * Fill convention mirrors the equity canonical engine's own NEXT_BAR_OPEN rule
 * (`canonicalNextBarEngine.ts`): a position transition detected at bar i fills at bar i+1's open.
 * Metrics reuse `metricsFromClosedTrades` from that same module rather than a second parallel
 * metrics implementation.
 *
 * Cost model: crypto fee/spread/slippage assumptions come from the reviewed
 * `config/cryptoInstruments.json` `paperExecution` block (the SAME assumptions
 * `CryptoPaperBroker.ts` uses for real paper fills) - reused, not reinvented - but labeled
 * `ESTIMATED` here, never `MEASURED`, because zero organic crypto fills exist yet to measure real
 * slippage from (CLAUDE.md canonicalCostModel.ts convention).
 */
import type { ResearchBar } from './ohlcvTypes';
import { metricsFromClosedTrades, type CanonicalTrade, type CanonicalMetrics } from './canonicalNextBarEngine';

export type CryptoStrategyPosition = 'LONG' | 'FLAT';

export interface CryptoBacktestSignal {
  barIndex: number;
  side: 'BUY' | 'SELL';
}

export type FetchCryptoStrategyFn = (
  strategyId: string,
  symbol: string,
  bars: ResearchBar[],
) => Promise<Record<string, unknown> | null>;

export interface CausalCryptoRunResult {
  signals: CryptoBacktestSignal[];
  evaluatedBars: number;
  nullResponseCount: number;
  /** True when nullResponseCount/evaluatedBars exceeds BRIDGE_DEGRADED_NULL_RATIO - a signal to the
   *  caller that this run reflects a Java Quant Core bridge outage/degradation (timeouts, circuit
   *  breaker open, process unresponsive), not a genuine "the strategy never triggers" finding. The
   *  Java Quant Core process is a real, shared, finite-capacity dependency (also used by the live
   *  production engine's advisory features) - a caller MUST NOT persist a result flagged this way as
   *  a valid backtest outcome. */
  bridgeDegraded: boolean;
}

/** Above this null-response ratio, treat the run as reflecting bridge unavailability rather than
 *  real strategy behavior. 50% is deliberately conservative - a handful of transient timeouts is
 *  normal and already handled by "hold position on null", but a majority-null run means the
 *  resulting signal sequence carries essentially no real information. */
const BRIDGE_DEGRADED_NULL_RATIO = 0.5;

/**
 * Walks the bar series forward one bar at a time, calling `fetchStrategy` with ONLY
 * `bars.slice(0, i + 1)` at step i - the caller-supplied Java bridge function never receives a bar
 * beyond the current point in time. A transition FLAT->LONG at bar i is recorded as a BUY signal at
 * barIndex i; LONG->FLAT is recorded as a SELL signal at barIndex i. A null/malformed response
 * (insufficient data, HTTP failure, disabled flag) is treated as "no new information" - the current
 * position is held, never forced to FLAT and never fabricated as LONG.
 */
export async function runCausalCryptoStrategy(params: {
  strategyId: string;
  symbol: string;
  bars: ResearchBar[];
  minBars: number;
  fetchStrategy: FetchCryptoStrategyFn;
}): Promise<CausalCryptoRunResult> {
  const { strategyId, symbol, bars, minBars, fetchStrategy } = params;
  const signals: CryptoBacktestSignal[] = [];
  let position: CryptoStrategyPosition = 'FLAT';
  let evaluatedBars = 0;
  let nullResponseCount = 0;

  for (let i = Math.max(minBars - 1, 0); i < bars.length; i++) {
    const causalSlice = bars.slice(0, i + 1); // NEVER bars beyond index i - this is the causality guarantee.
    const response = await fetchStrategy(strategyId, symbol, causalSlice);
    evaluatedBars++;
    if (!response || typeof response !== 'object') {
      nullResponseCount++;
      continue;
    }
    const rawPosition = response.position;
    const nextPosition: CryptoStrategyPosition = rawPosition === 'LONG' ? 'LONG' : rawPosition === 'FLAT' ? 'FLAT' : position;
    if (nextPosition !== position) {
      signals.push({ barIndex: i, side: nextPosition === 'LONG' ? 'BUY' : 'SELL' });
      position = nextPosition;
    }
  }

  const bridgeDegraded = evaluatedBars > 0 && nullResponseCount / evaluatedBars > BRIDGE_DEGRADED_NULL_RATIO;
  return { signals, evaluatedBars, nullResponseCount, bridgeDegraded };
}

export interface CryptoFillCosts {
  spreadBps: number;
  slippageBps: number;
  feeBps: number;
  /** Fixed research notional per entry, in USD. A backtest-sizing convenience only - this module
   *  never sizes a real order and never calls PositionSizing.ts. */
  notionalPerTradeUsd: number;
}

function buyFillPrice(open: number, costs: CryptoFillCosts): number {
  return open * (1 + (costs.spreadBps + costs.slippageBps) / 10000);
}

function sellFillPrice(open: number, costs: CryptoFillCosts): number {
  return open * (1 - (costs.spreadBps + costs.slippageBps) / 10000);
}

/**
 * Long-only NEXT_BAR_OPEN fills for the crypto signal sequence produced by runCausalCryptoStrategy.
 * A BUY at signal bar i fills at bar i+1's open; a SELL likewise. Fee is a percentage of notional
 * (crypto convention), unlike the equity engine's per-share commission - kept as a separate,
 * honestly-distinct function rather than force-fitting crypto economics into
 * `applyNextBarLongFills`'s per-share contract.
 */
export function applyCryptoNextBarFills(
  bars: ResearchBar[],
  signals: CryptoBacktestSignal[],
  costs: CryptoFillCosts,
): { trades: CanonicalTrade[]; unclosedCount: number } {
  const trades: CanonicalTrade[] = [];
  let open: CanonicalTrade | null = null;

  for (const sig of signals) {
    const exec = sig.barIndex + 1;
    if (exec >= bars.length) continue; // signal on the final bar has no next-bar open to fill at - correctly dropped, never fabricated.
    if (sig.side === 'BUY' && !open) {
      const px = buyFillPrice(bars[exec].open, costs);
      const qty = costs.notionalPerTradeUsd / px;
      const commission = (costs.feeBps / 10000) * costs.notionalPerTradeUsd;
      open = {
        side: 'BUY',
        signalBarIndex: sig.barIndex,
        fillBarIndex: exec,
        fillPrice: px,
        qty,
        commission,
        stop: null,
        target: null,
        exitReason: 'UNCLOSED',
        pnl: null,
        regime: null,
      };
    } else if (sig.side === 'SELL' && open) {
      const px = sellFillPrice(bars[exec].open, costs);
      const exitNotional = px * open.qty;
      const commission = (costs.feeBps / 10000) * exitNotional;
      const pnl = (px - open.fillPrice) * open.qty - commission - open.commission;
      trades.push({
        ...open,
        side: 'SELL',
        signalBarIndex: sig.barIndex,
        fillBarIndex: exec,
        fillPrice: px,
        commission: open.commission + commission,
        exitReason: 'SIGNAL',
        pnl,
      });
      open = null;
    }
  }

  return { trades, unclosedCount: open ? 1 : 0 };
}

export function summarizeCryptoBacktest(trades: CanonicalTrade[], minSample: number): CanonicalMetrics {
  return metricsFromClosedTrades(trades, minSample);
}
