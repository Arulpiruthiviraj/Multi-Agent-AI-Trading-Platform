/**
 * ==========================================================
 * Module:
 * PortfolioMonitor.ts
 *
 * Purpose:
 * Core implementation and logic for the PortfolioMonitor.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for PortfolioMonitor
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import { db } from '../db';
import { portfolio, settings, trades } from '../db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { marketDataWorker } from './MarketDataWorker';

// E2A (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - these were previously hardcoded literals
// (+5%/-3%) unrelated to settings.takeProfitPct/trailingStopPct, which already existed in the
// schema (defaults 15/5, matching BacktestEngine.run()'s own hardcoded assumption) but were never
// read by anything. Used only when the settings table genuinely has no row yet (should not happen
// in normal operation - the app always seeds one), so this fallback matches the schema's own
// column defaults rather than the old, unrelated hardcoded values.
const FALLBACK_TAKE_PROFIT_PCT = 15;
const FALLBACK_TRAILING_STOP_PCT = 5;

export class PortfolioMonitorWorker {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    console.log("[PortfolioWorker] Started monitoring loop.");
    this.intervalId = setInterval(() => this.reviewPortfolio(), 60000);
    this.reviewPortfolio();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[PortfolioWorker] Stopped.");
    }
  }

  async reviewPortfolio() {
    try {
      const holdings = await db.select().from(portfolio).all();
      if (holdings.length === 0) return;
      console.log(`[PortfolioWorker] Reviewing ${holdings.length} active positions.`);

      // E2A - read the same settings.takeProfitPct/trailingStopPct BacktestEngine.run() assumes
      // (previously never read by live PortfolioMonitor, which used unrelated hardcoded +5%/-3%
      // literals instead - see CLAUDE.md's former "Known Broken/Non-Functional Components" entry
      // for this exact mismatch).
      const settingsRow = (await db.select().from(settings).limit(1))[0];
      const takeProfitPct = settingsRow?.takeProfitPct ?? FALLBACK_TAKE_PROFIT_PCT;
      const trailingStopPct = settingsRow?.trailingStopPct ?? FALLBACK_TRAILING_STOP_PCT;

      for (const holding of holdings) {
        if (holding.quantity <= 0) continue;

        const currentLivePrice = marketDataWorker.getLatestPrice(holding.symbol);
        if (!currentLivePrice) continue;

        // Phase 16B (ARGUS_PHASE16_READINESS_REPORT.md) - a QuantEngine-originated position
        // carries its own strategy's real stop/target, captured on the trade row at the exact
        // moment it was opened (ChiefTraderAgent's supportingQuantDetail, threaded through
        // RiskEngine/OrderManagement). Honor that instead of the generic settings-driven
        // percentage thresholds when present - this is the live-behavior half of closing
        // LIVE_BACKTEST_PARITY_SPEC.md's "quant strategy exit" gap (user-confirmed direction:
        // make live exits strategy-aware, not make the backtest less informative). Every other
        // position (technical/news/fundamental-sourced, or a QuantEngine trade whose strategy
        // didn't propose a stop/target) falls through to the unchanged generic exit below.
        const [openingTrade] = await db.select().from(trades)
          .where(and(eq(trades.symbol, holding.symbol), eq(trades.side, 'BUY'), eq(trades.status, 'FILLED')))
          .orderBy(desc(trades.filledAt))
          .limit(1);
        const quantStop = openingTrade?.quantStopPrice ?? null;
        const quantTarget = openingTrade?.quantTargetPrice ?? null;

        if (quantStop !== null || quantTarget !== null) {
          if (quantTarget !== null && currentLivePrice >= quantTarget) {
            console.log(`[PortfolioWorker] Quant strategy (${openingTrade!.quantStrategyId}) target reached on ${holding.symbol}: $${currentLivePrice.toFixed(2)} >= $${quantTarget.toFixed(2)}`);
            eventBus.emitTradeIdea({
              traceId: Math.random().toString(36).substring(7),
              symbol: holding.symbol,
              side: "SELL",
              confidence: 0.85,
              currentPrice: currentLivePrice,
              reasoning: `Quant strategy (${openingTrade!.quantStrategyId}) target reached: $${currentLivePrice.toFixed(2)} >= $${quantTarget.toFixed(2)}. Scaling out to manage risk.`,
              agent: "PortfolioManager"
            });
          } else if (quantStop !== null && currentLivePrice <= quantStop) {
            console.log(`[PortfolioWorker] Quant strategy (${openingTrade!.quantStrategyId}) stop hit on ${holding.symbol}: $${currentLivePrice.toFixed(2)} <= $${quantStop.toFixed(2)}`);
            eventBus.emitTradeIdea({
              traceId: Math.random().toString(36).substring(7),
              symbol: holding.symbol,
              side: "SELL",
              confidence: 0.95,
              currentPrice: currentLivePrice,
              reasoning: `Quant strategy (${openingTrade!.quantStrategyId}) stop hit: $${currentLivePrice.toFixed(2)} <= $${quantStop.toFixed(2)}. Preserving capital.`,
              agent: "PortfolioManager"
            });
          }
          continue; // strategy-aware exit already evaluated this position - skip the generic percentage check below
        }

        const PnL = ((currentLivePrice - holding.averagePrice) / holding.averagePrice) * 100;

        if (PnL > takeProfitPct) {
           console.log(`[PortfolioWorker] Taking profit on ${holding.symbol} (+${PnL.toFixed(2)}%)`);
           eventBus.emitTradeIdea({
             traceId: Math.random().toString(36).substring(7),
             symbol: holding.symbol,
             side: "SELL",
             confidence: 0.85,
             currentPrice: currentLivePrice,
             reasoning: `Target profit reached (+${PnL.toFixed(2)}%, threshold +${takeProfitPct}%). Scaling out to manage risk.`,
             agent: "PortfolioManager"
           });
        } else if (PnL < -trailingStopPct) {
           console.log(`[PortfolioWorker] Cutting loss on ${holding.symbol} (${PnL.toFixed(2)}%)`);
           eventBus.emitTradeIdea({
             traceId: Math.random().toString(36).substring(7),
             symbol: holding.symbol,
             side: "SELL",
             confidence: 0.95,
             currentPrice: currentLivePrice,
             reasoning: `Hard stop hit (${PnL.toFixed(2)}%, threshold -${trailingStopPct}%). Preserving capital.`,
             agent: "PortfolioManager"
           });
        }
      }
    } catch (e) {
      console.error("[PortfolioWorker] Error during review:", e);
    }
  }
}

export const portfolioMonitor = new PortfolioMonitorWorker();
