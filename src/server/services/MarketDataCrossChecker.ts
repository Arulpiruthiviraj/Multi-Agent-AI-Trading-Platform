/**
 * ==========================================================
 * Module: MarketDataCrossChecker
 *
 * Purpose:
 * Argus's first genuinely independent second market-data source. On a fixed interval, compares
 * Alpaca's live streamed price (MarketDataWorker - the sole real feed TechnicalAgent and every
 * other price-consuming agent actually sees) against Questrade's real Level 1 quote for the same
 * symbol, and emits MARKET_DATA_SOURCE_DISCREPANCY when the two disagree beyond
 * DIVERGENCE_THRESHOLD_PCT.
 *
 * Deliberately narrow in scope:
 *   - This is a cross-check, not a second trading signal. It never calls into RiskEngine's gate
 *     ladder or any agent's decision path. Wiring a discrepancy into an actual trade-blocking
 *     gate is a separate, deliberate decision affecting the safety-critical gate ladder - not
 *     bundled into this pass.
 *   - Reuses BrokerManager's already-authenticated Questrade instance rather than creating a new
 *     one - Questrade's refresh tokens are single-use, so a second independent authenticate()
 *     call here would invalidate/be invalidated by BrokerManager's own.
 *   - Idles silently (does nothing, emits nothing) whenever Questrade isn't registered,
 *     unauthenticated, or a given symbol has no live Alpaca price yet - never fabricates a
 *     comparison out of partial data.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { BrokerManager } from '../../brokers/BrokerManager';
import { marketDataWorker } from './MarketDataWorker';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { quantThresholds } from '../config/quantThresholds';
import { createSingleFlightGuard, type SingleFlightGuard } from '../core/singleFlightInterval';

const CHECK_INTERVAL_MS = runtimeIntervals.marketDataCrossCheckMs;
export const DIVERGENCE_THRESHOLD_PCT = quantThresholds.priceSourceDivergencePct;

export function computeDivergencePct(alpacaPrice: number, questradePrice: number): number {
  return Math.abs(alpacaPrice - questradePrice) / questradePrice * 100;
}

interface QuestradeLikeQuoteSource {
  health(): Promise<string>;
  getQuote(symbol: string): Promise<{ last: number }>;
}

export class MarketDataCrossChecker {
  private intervalId: NodeJS.Timeout | null = null;
  // Real gap found and fixed (2026-09-15, post-forensic-audit timer sweep): runCheck() sequentially
  // awaits a real Questrade REST call per active symbol, so its own duration scales with active-
  // symbol count and Questrade latency - with no guard, a slow cycle overlapping the next tick
  // doubled outbound Questrade calls for the same symbol set. Not a P1-A-class danger (no growing
  // table, no unbounded memory), but a real, avoidable API-quota/rate-limit waste - same reusable
  // guard every other periodic worker in this codebase already uses.
  private readonly guard: SingleFlightGuard = createSingleFlightGuard(
    (e) => console.error('[MarketDataCrossChecker] check failed', e),
  );

  constructor(
    private readonly getQuestradeSource: () => QuestradeLikeQuoteSource | undefined = () =>
      BrokerManager.getInstance().getBroker('questrade') as unknown as QuestradeLikeQuoteSource | undefined,
    private readonly getActiveSymbols: () => string[] = () => marketDataWorker.getActiveSymbols(),
    private readonly getAlpacaPrice: (symbol: string) => number | null = (symbol) => marketDataWorker.getLatestPrice(symbol),
  ) {}

  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      this.runCheck().catch((e) => console.error('[MarketDataCrossChecker] check failed', e));
    }, CHECK_INTERVAL_MS);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getGuardMetrics() {
    return this.guard.getMetrics();
  }

  /** Public entry point - coalesces against any other in-flight call through the SAME guard
   *  instance (timer-driven or a future manual "check now" caller), not just the timer path. */
  async runCheck(): Promise<void> {
    await this.guard.run(() => this.runCheckInternal());
  }

  private async runCheckInternal(): Promise<void> {
    const questrade = this.getQuestradeSource();
    if (!questrade || typeof questrade.getQuote !== 'function') return;

    const health = await questrade.health().catch(() => 'Offline');
    if (health !== 'Healthy') return;

    for (const symbol of this.getActiveSymbols()) {
      const alpacaPrice = this.getAlpacaPrice(symbol);
      if (alpacaPrice === null) continue;

      try {
        const quote = await questrade.getQuote(symbol);
        const questradePrice = quote.last;
        if (!questradePrice) continue;

        const divergencePct = computeDivergencePct(alpacaPrice, questradePrice);
        if (divergencePct > DIVERGENCE_THRESHOLD_PCT) {
          const payload = {
            symbol,
            alpacaPrice,
            questradePrice,
            divergencePct: Number(divergencePct.toFixed(3)),
            timestamp: new Date().toISOString(),
          };
          console.warn(
            `[MarketDataCrossChecker] ${symbol}: Alpaca ${alpacaPrice} vs Questrade ${questradePrice} (${payload.divergencePct}% divergence)`
          );
          eventBus.emit(EVENTS.MARKET_DATA_SOURCE_DISCREPANCY, payload);
        }
      } catch (e: any) {
        console.error(`[MarketDataCrossChecker] Questrade quote failed for ${symbol}: ${e.message}`);
      }
    }
  }
}

export const marketDataCrossChecker = new MarketDataCrossChecker();
