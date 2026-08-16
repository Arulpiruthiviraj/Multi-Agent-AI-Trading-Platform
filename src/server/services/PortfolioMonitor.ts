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
import { EVENTS } from '../core/eventNames';
import { tradingSafety } from '../config/tradingSafety';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { agentWeightConfig } from '../config/agentWeights';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { classifyRegime, MIN_BARS } from '../quant/RegimeEngine';
import { computeVolumeFeatures } from '../quant/indicators/volume';
import { evaluateThesisInvalidation, parseStoredThesis } from '../quant/analysis/ThesisInvalidation';

// E2A (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - these were previously hardcoded literals
// (+5%/-3%) unrelated to settings.takeProfitPct/trailingStopPct, which already existed in the
// schema (defaults 15/5, matching BacktestEngine.run()'s own hardcoded assumption) but were never
// read by anything. Used only when the settings table genuinely has no row yet (should not happen
// in normal operation - the app always seeds one), so this fallback matches the schema's own
// column defaults rather than the old, unrelated hardcoded values.
const FALLBACK_TAKE_PROFIT_PCT = tradingSafety.fallbackTakeProfitPct;
const FALLBACK_TRAILING_STOP_PCT = tradingSafety.fallbackTrailingStopPct;

export class PortfolioMonitorWorker {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    console.log("[PortfolioWorker] Started monitoring loop.");
    this.intervalId = setInterval(() => this.reviewPortfolio(), runtimeIntervals.portfolioMonitorMs);
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
        const storedThesis = parseStoredThesis((openingTrade as any)?.quantInvalidationJson);

        const PnL = ((currentLivePrice - holding.averagePrice) / holding.averagePrice) * 100;
        const surveillance = {
          symbol: holding.symbol,
          entryPrice: holding.averagePrice,
          currentPrice: currentLivePrice,
          quantity: holding.quantity,
          pnlPct: PnL,
          quantStrategyId: openingTrade?.quantStrategyId ?? null,
          quantStop,
          quantTarget,
          originalThesis: storedThesis,
        };
        eventBus.emit(EVENTS.POSITION_MONITORED, surveillance);
        const riskLevel = PnL <= -trailingStopPct ? 'HIGH'
          : PnL <= -(trailingStopPct * tradingSafety.positionRiskElevatedFraction) ? 'ELEVATED'
          : 'NORMAL';
        if (riskLevel !== 'NORMAL') {
          eventBus.emit(EVENTS.POSITION_RISK_CHANGED, { ...surveillance, riskLevel });
        }

        if (quantStop !== null || quantTarget !== null || storedThesis) {
          if (quantTarget !== null && currentLivePrice >= quantTarget) {
            console.log(`[PortfolioWorker] Quant strategy (${openingTrade!.quantStrategyId}) target reached on ${holding.symbol}: $${currentLivePrice.toFixed(2)} >= $${quantTarget.toFixed(2)}`);
            eventBus.emitTradeIdea({
              traceId: Math.random().toString(36).substring(7),
              symbol: holding.symbol,
              side: "SELL",
              confidence: tradingSafety.quantExitIdeaConfidence,
              currentPrice: currentLivePrice,
              reasoning: `EXIT_CODE=TARGET_REACHED Quant strategy (${openingTrade!.quantStrategyId}) target reached: $${currentLivePrice.toFixed(2)} >= $${quantTarget.toFixed(2)}. Scaling out to manage risk.`,
              agent: agentWeightConfig.riskExitAgent
            });
            continue;
          } else if (quantStop !== null && currentLivePrice <= quantStop) {
            console.log(`[PortfolioWorker] Quant strategy (${openingTrade!.quantStrategyId}) stop hit on ${holding.symbol}: $${currentLivePrice.toFixed(2)} <= $${quantStop.toFixed(2)}`);
            eventBus.emitTradeIdea({
              traceId: Math.random().toString(36).substring(7),
              symbol: holding.symbol,
              side: "SELL",
              confidence: tradingSafety.quantStopExitConfidence,
              currentPrice: currentLivePrice,
              reasoning: `EXIT_CODE=HARD_STOP Quant strategy (${openingTrade!.quantStrategyId}) stop hit: $${currentLivePrice.toFixed(2)} <= $${quantStop.toFixed(2)}. Preserving capital.`,
              agent: agentWeightConfig.riskExitAgent
            });
            continue;
          } else if (storedThesis) {
            const invalidation = await this.evaluateLiveThesis(holding.symbol, storedThesis);
            if (invalidation) {
              console.log(`[PortfolioWorker] Original thesis invalidated on ${holding.symbol}: ${invalidation}`);
              eventBus.emitTradeIdea({
                traceId: Math.random().toString(36).substring(7),
                symbol: holding.symbol,
                side: "SELL",
                confidence: tradingSafety.thesisInvalidationExitConfidence,
                currentPrice: currentLivePrice,
                reasoning: `EXIT_CODE=THESIS_INVALIDATION Original thesis invalidated (${openingTrade!.quantStrategyId ?? storedThesis.strategy}): ${invalidation}`,
                agent: agentWeightConfig.riskExitAgent
              });
              continue;
            }
          }
          if (PnL < -trailingStopPct) {
            eventBus.emitTradeIdea({
              traceId: Math.random().toString(36).substring(7),
              symbol: holding.symbol,
              side: "SELL",
              confidence: tradingSafety.quantStopExitConfidence,
              currentPrice: currentLivePrice,
              reasoning: `EXIT_CODE=TRAILING_STOP Live trailing-stop backstop (${PnL.toFixed(2)}%, threshold -${trailingStopPct}%) in addition to strategy stop/target.`,
              agent: agentWeightConfig.riskExitAgent
            });
          }
          continue;
        }

        if (PnL > takeProfitPct) {
           console.log(`[PortfolioWorker] Taking profit on ${holding.symbol} (+${PnL.toFixed(2)}%)`);
           eventBus.emitTradeIdea({
             traceId: Math.random().toString(36).substring(7),
             symbol: holding.symbol,
             side: "SELL",
             confidence: tradingSafety.quantExitIdeaConfidence,
             currentPrice: currentLivePrice,
             reasoning: `EXIT_CODE=TARGET_REACHED Target profit reached (+${PnL.toFixed(2)}%, threshold +${takeProfitPct}%). Scaling out to manage risk.`,
             agent: agentWeightConfig.riskExitAgent
           });
        } else if (PnL < -trailingStopPct) {
           console.log(`[PortfolioWorker] Cutting loss on ${holding.symbol} (${PnL.toFixed(2)}%)`);
           eventBus.emitTradeIdea({
             traceId: Math.random().toString(36).substring(7),
             symbol: holding.symbol,
             side: "SELL",
             confidence: tradingSafety.quantStopExitConfidence,
             currentPrice: currentLivePrice,
             reasoning: `EXIT_CODE=HARD_STOP Hard stop hit (${PnL.toFixed(2)}%, threshold -${trailingStopPct}%). Preserving capital.`,
             agent: agentWeightConfig.riskExitAgent
           });
        }
      }
    } catch (e) {
      console.error("[PortfolioWorker] Error during review:", e);
    }
  }

  /**
   * Re-reads real daily bars and re-runs the same regime/volume/structure features the
   * QuantEngine used at entry. Returns a human-readable reason when the original thesis is
   * dead, or null when bars are too thin / unavailable (never a fabricated invalidation).
   */
  private async evaluateLiveThesis(symbol: string, thesis: ReturnType<typeof parseStoredThesis>): Promise<string | null> {
    if (!thesis) return null;
    try {
      const endMs = Date.now();
      const startMs = endMs - 400 * 24 * 60 * 60 * 1000;
      const bars = await historicalDataGateway.getBars(symbol, '1Day', startMs, endMs);
      if (bars.length < MIN_BARS) return null;

      const regime = classifyRegime(bars);
      const volume = computeVolumeFeatures(bars);
      const trend = regime.features.trend;
      const result = evaluateThesisInvalidation(thesis, {
        regime: regime.insufficientData ? null : regime.regime,
        rvol: volume.relativeVolume,
        adx: trend.dmi?.adx ?? null,
        structureEvent: trend.structure.event,
        structureTrend: trend.structure.trend,
        lastClose: bars[bars.length - 1].close,
        bars,
      });
      return result.invalidated ? result.reasons.join(' ') : null;
    } catch (e) {
      console.warn(`[PortfolioWorker] Could not re-evaluate thesis for ${symbol} (no honest bar history):`, (e as Error).message);
      return null;
    }
  }
}

export const portfolioMonitor = new PortfolioMonitorWorker();
