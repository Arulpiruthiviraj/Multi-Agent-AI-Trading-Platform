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
import { randomUUID } from 'node:crypto';
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
import {
  canEmitPortfolioExitIdea,
  ensureHoldingSubscribed,
  recordPortfolioDecision,
} from '../continuous/portfolioIntel';
import { evaluateExit } from './ExitIntelligenceEngine';
import { isExitIntelligenceEnabled } from '../config/exitIntelligence';
import { replaySafety } from '../replay/replaySafety';
import { getCampaignBuyLockAction } from '../core/campaignBuyLock';

// E2A (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - these were previously hardcoded literals
// (+5%/-3%) unrelated to settings.takeProfitPct/trailingStopPct, which already existed in the
// schema (defaults 15/5, matching BacktestEngine.run()'s own hardcoded assumption) but were never
// read by anything. Used only when the settings table genuinely has no row yet (should not happen
// in normal operation - the app always seeds one), so this fallback matches the schema's own
// column defaults rather than the old, unrelated hardcoded values.
const FALLBACK_TAKE_PROFIT_PCT = tradingSafety.fallbackTakeProfitPct;
const FALLBACK_TRAILING_STOP_PCT = tradingSafety.fallbackTrailingStopPct;

/**
 * Daily Goal Campaign, TRAIL_STOPS_ONLY action only (ARGUS_CAMPAIGN_TRACKER.md /
 * ARGUS_INDEPENDENT_LEARNING... campaign audit): once today's target is reached under this
 * specific action, open positions' trailing stop tightens toward capital preservation - CampaignTracker
 * itself does not invent trail math (see its own header comment); this is that real math, living
 * where every other trailing-stop number already lives. Math.min so this can only ever TIGHTEN the
 * effective stop, never loosen it below whatever the operator's own settings.trailingStopPct
 * already was.
 */
function resolveEffectiveTrailingStopPct(baseTrailingStopPct: number): number {
  if (getCampaignBuyLockAction() === 'TRAIL_STOPS_ONLY') {
    return Math.min(baseTrailingStopPct, tradingSafety.campaignTrailStopsOnlyPct);
  }
  return baseTrailingStopPct;
}

/** Research/sim fills must never supply stop/target metadata for live portfolio exits. */
const NON_LIVE_OPENING_TRADE_ENVS = new Set([
  'REPLAY',
  'BACKTEST',
  'SIMULATION',
  'HISTORICAL_REPLAY',
  'HISTORICAL_SIMULATION',
  'TELEMETRY_PULSE',
]);

/**
 * Most recent FILLED BUY that may own live exit metadata for an open holding.
 * Excludes REPLAY/BACKTEST/etc. — forensic 2026-08-20: PortfolioMonitor bound a REPLAY
 * MOMENTUM_BREAKOUT NVDA fill ($114 / target $121.90) onto a live EXTERNAL_SYNC position
 * (~$206), producing perpetual TARGET_REACHED noise.
 */
export async function resolveOpeningTradeForLiveExit(symbol: string) {
  const candidates = await db.select().from(trades)
    .where(and(eq(trades.symbol, symbol), eq(trades.side, 'BUY'), eq(trades.status, 'FILLED')))
    .orderBy(desc(trades.filledAt))
    .limit(40);
  return candidates.find((t) => {
    const env = String(t.executionEnvironment || '').toUpperCase();
    if (NON_LIVE_OPENING_TRADE_ENVS.has(env)) return false;
    if (t.traceId && String(t.traceId).startsWith(replaySafety.replayTracePrefix)) return false;
    return true;
  }) ?? null;
}

/**
 * Long take-profit is only valid above cost basis. Targets at/below entry (or mismatched REPLAY
 * leftovers) must not force TARGET_REACHED sells.
 */
export function isValidLongQuantTarget(quantTarget: number, averagePrice: number): boolean {
  return Number.isFinite(quantTarget) && Number.isFinite(averagePrice) && quantTarget > averagePrice;
}

/**
 * Real stop-loss/take-profit price for one position, for display (e.g. the positions ledger).
 * Mirrors reviewPortfolio()'s own precedence exactly, so the number shown is the number that will
 * actually trigger an exit - not a separately-invented approximation: a QuantEngine-originated
 * position's own quantStopPrice/quantTargetPrice (captured on its opening trade) takes precedence
 * when present; every other position falls back to the same settings.takeProfitPct/trailingStopPct
 * percentages the live exit logic above already uses.
 */
export async function resolvePositionStopTarget(
  symbol: string,
  averagePrice: number,
): Promise<{ stopLossPrice: number; takeProfitPrice: number }> {
  const openingTrade = await resolveOpeningTradeForLiveExit(symbol);
  const settingsRow = (await db.select().from(settings).limit(1))[0];
  const takeProfitPct = settingsRow?.takeProfitPct ?? FALLBACK_TAKE_PROFIT_PCT;
  const trailingStopPct = resolveEffectiveTrailingStopPct(settingsRow?.trailingStopPct ?? FALLBACK_TRAILING_STOP_PCT);

  const stopLossPrice = openingTrade?.quantStopPrice ?? averagePrice * (1 - trailingStopPct / 100);
  const takeProfitPrice = openingTrade?.quantTargetPrice ?? averagePrice * (1 + takeProfitPct / 100);
  return {
    stopLossPrice: Number(stopLossPrice.toFixed(2)),
    takeProfitPrice: Number(takeProfitPrice.toFixed(2)),
  };
}

export class PortfolioMonitorWorker {
  private intervalId: NodeJS.Timeout | null = null;
  // Real bug fixed: setInterval had no in-flight guard. reviewPortfolio() awaits a real bars
  // fetch (evaluateLiveThesis, up to 400 days) plus a DB lookup per holding - with several open
  // positions this can plausibly exceed the 60s tick, letting a second invocation start while the
  // first is still running. Each independently able to emit a SELL TRADE_IDEA_GENERATED for the
  // same holding - a real duplicate/over-sell risk (see also ChiefTraderAgent's own per-symbol
  // serialization fix for risk-exit ideas, same class of bug at the next stage).
  private isReviewing = false;

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
    if (this.isReviewing) {
      console.warn("[PortfolioWorker] Previous review cycle still running - skipping this tick instead of overlapping.");
      return;
    }
    this.isReviewing = true;
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
      const trailingStopPct = resolveEffectiveTrailingStopPct(settingsRow?.trailingStopPct ?? FALLBACK_TRAILING_STOP_PCT);

      for (const holding of holdings) {
        if (holding.quantity <= 0) continue;

        ensureHoldingSubscribed(holding.symbol);
        const currentLivePrice = marketDataWorker.getLatestPrice(holding.symbol);
        if (!currentLivePrice) {
          recordPortfolioDecision({
            symbol: holding.symbol,
            state: 'NO_PRICE',
            reason: 'No live IEX tick yet — SELL not fabricated.',
            currentPrice: null,
          });
          continue;
        }

        // Phase 16B (ARGUS_PHASE16_READINESS_REPORT.md) - a QuantEngine-originated position
        // carries its own strategy's real stop/target, captured on the trade row at the exact
        // moment it was opened (ChiefTraderAgent's supportingQuantDetail, threaded through
        // RiskEngine/OrderManagement). Honor that instead of the generic settings-driven
        // percentage thresholds when present - this is the live-behavior half of closing
        // LIVE_BACKTEST_PARITY_SPEC.md's "quant strategy exit" gap (user-confirmed direction:
        // make live exits strategy-aware, not make the backtest less informative). Every other
        // position (technical/news/fundamental-sourced, or a QuantEngine trade whose strategy
        // didn't propose a stop/target) falls through to the unchanged generic exit below.
        // Must exclude REPLAY/BACKTEST FILLED BUYs — they share the trades table and would
        // otherwise attach research stop/target metadata to live/EXTERNAL_SYNC holdings.
        const openingTrade = await resolveOpeningTradeForLiveExit(holding.symbol);
        const quantStop = openingTrade?.quantStopPrice ?? null;
        const quantTargetRaw = openingTrade?.quantTargetPrice ?? null;
        const quantTarget = quantTargetRaw !== null && isValidLongQuantTarget(quantTargetRaw, holding.averagePrice)
          ? quantTargetRaw
          : null;
        if (quantTargetRaw !== null && quantTarget === null) {
          console.warn(
            `[PortfolioWorker] Ignoring invalid long quant_target_price $${quantTargetRaw} for ${holding.symbol} ` +
            `(avg entry $${holding.averagePrice}) — not forcing TARGET_REACHED.`,
          );
        }
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
            this.emitRiskExit({
              symbol: holding.symbol,
              currentPrice: currentLivePrice,
              pnlPct: PnL,
              confidence: tradingSafety.quantExitIdeaConfidence,
              reasoning: `EXIT_CODE=TARGET_REACHED Quant strategy (${openingTrade!.quantStrategyId}) target reached: $${currentLivePrice.toFixed(2)} >= $${quantTarget.toFixed(2)}. Scaling out to manage risk.`,
            });
            continue;
          } else if (quantStop !== null && currentLivePrice <= quantStop) {
            console.log(`[PortfolioWorker] Quant strategy (${openingTrade!.quantStrategyId}) stop hit on ${holding.symbol}: $${currentLivePrice.toFixed(2)} <= $${quantStop.toFixed(2)}`);
            this.emitRiskExit({
              symbol: holding.symbol,
              currentPrice: currentLivePrice,
              pnlPct: PnL,
              confidence: tradingSafety.quantStopExitConfidence,
              reasoning: `EXIT_CODE=HARD_STOP Quant strategy (${openingTrade!.quantStrategyId}) stop hit: $${currentLivePrice.toFixed(2)} <= $${quantStop.toFixed(2)}. Preserving capital.`,
            });
            continue;
          } else if (storedThesis) {
            const invalidation = await this.evaluateLiveThesis(holding.symbol, storedThesis);
            if (invalidation) {
              console.log(`[PortfolioWorker] Original thesis invalidated on ${holding.symbol}: ${invalidation}`);
              this.emitRiskExit({
                symbol: holding.symbol,
                currentPrice: currentLivePrice,
                pnlPct: PnL,
                confidence: tradingSafety.thesisInvalidationExitConfidence,
                reasoning: `EXIT_CODE=THESIS_INVALIDATION Original thesis invalidated (${openingTrade!.quantStrategyId ?? storedThesis.strategy}): ${invalidation}`,
              });
              continue;
            }
          }
          if (PnL < -trailingStopPct) {
            this.emitRiskExit({
              symbol: holding.symbol,
              currentPrice: currentLivePrice,
              pnlPct: PnL,
              confidence: tradingSafety.quantStopExitConfidence,
              reasoning: `EXIT_CODE=TRAILING_STOP Live trailing-stop backstop (${PnL.toFixed(2)}%, threshold -${trailingStopPct}%) in addition to strategy stop/target.`,
            });
          } else {
            recordPortfolioDecision({
              symbol: holding.symbol,
              state: riskLevel === 'NORMAL' ? 'HEALTHY' : 'WARNING',
              pnlPct: PnL,
              currentPrice: currentLivePrice,
              reason: 'Quant stop/target/thesis still valid. HOLD. Risk-exit SELL still skips entry quorum when triggered.',
            });
          }
          continue;
        }

        if (PnL > takeProfitPct) {
           console.log(`[PortfolioWorker] Taking profit on ${holding.symbol} (+${PnL.toFixed(2)}%)`);
           this.emitRiskExit({
             symbol: holding.symbol,
             currentPrice: currentLivePrice,
             pnlPct: PnL,
             confidence: tradingSafety.quantExitIdeaConfidence,
             reasoning: `EXIT_CODE=TARGET_REACHED Target profit reached (+${PnL.toFixed(2)}%, threshold +${takeProfitPct}%). Scaling out to manage risk.`,
           });
        } else if (PnL < -trailingStopPct) {
           console.log(`[PortfolioWorker] Cutting loss on ${holding.symbol} (${PnL.toFixed(2)}%)`);
           this.emitRiskExit({
             symbol: holding.symbol,
             currentPrice: currentLivePrice,
             pnlPct: PnL,
             confidence: tradingSafety.quantStopExitConfidence,
             reasoning: `EXIT_CODE=HARD_STOP Hard stop hit (${PnL.toFixed(2)}%, threshold -${trailingStopPct}%). Preserving capital.`,
           });
        } else if (isExitIntelligenceEnabled() && await this.consultExitIntelligence(holding, currentLivePrice, PnL, openingTrade?.filledAt ?? null)) {
          // Handled inside consultExitIntelligence() (either emitted a risk exit or recorded HOLD).
        } else {
          recordPortfolioDecision({
            symbol: holding.symbol,
            state: riskLevel === 'NORMAL' ? 'HEALTHY' : 'WARNING',
            pnlPct: PnL,
            currentPrice: currentLivePrice,
            reason: 'No hard-exit trigger this cycle. HOLD is valid. Entry-style 2-agent consensus is not required for this HOLD.',
          });
        }
      }
    } catch (e) {
      console.error("[PortfolioWorker] Error during review:", e);
    } finally {
      this.isReviewing = false;
    }
  }

  private emitRiskExit(args: {
    symbol: string;
    currentPrice: number;
    pnlPct: number;
    confidence: number;
    reasoning: string;
  }) {
    if (!canEmitPortfolioExitIdea(args.symbol)) {
      recordPortfolioDecision({
        symbol: args.symbol,
        state: 'WATCH',
        pnlPct: args.pnlPct,
        currentPrice: args.currentPrice,
        reason: 'Exit idea suppressed by overlay cooldown — not a broker skip. Previous SELL idea still must clear RiskEngine/OMS.',
      });
      return;
    }
    eventBus.emitTradeIdea({
      traceId: randomUUID(),
      symbol: args.symbol,
      side: 'SELL',
      confidence: args.confidence,
      currentPrice: args.currentPrice,
      reasoning: args.reasoning,
      agent: agentWeightConfig.riskExitAgent,
    });
    recordPortfolioDecision({
      symbol: args.symbol,
      state: 'EXIT_CANDIDATE',
      pnlPct: args.pnlPct,
      currentPrice: args.currentPrice,
      reason: args.reasoning,
    });
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

  /**
   * ARGUS_EXIT_INTELLIGENCE_PLAN.md - only ever consulted after every existing exit check
   * (quant stop/target, thesis invalidation, generic take-profit/trailing-stop) has already found
   * nothing this cycle. Off by default (ARGUS_EXIT_INTELLIGENCE_ENABLED). Returns true once it has
   * fully handled the decision (recorded telemetry, and emitted a risk-exit idea if warranted) so
   * the caller does not also record a duplicate generic HOLD.
   *
   * Real constraint discovered while wiring this in (documented in the plan's own §7, now
   * empirically confirmed): RiskEngine's SELL sizing always clamps to the FULL held quantity today
   * - there is no quantity-aware SELL idea path anywhere in the current spine. Emitting a risk-exit
   * idea for a PARTIAL_TAKE_PROFIT decision would therefore incorrectly sell the entire position,
   * not a partial one. Until a deliberate, reviewed quantity-aware SELL idea shape exists,
   * PARTIAL_TAKE_PROFIT and TRAIL are recorded as telemetry only, never auto-executed - only
   * TAKE_PROFIT/EXIT/EMERGENCY_EXIT (genuinely full-position-appropriate decisions) act.
   */
  private async consultExitIntelligence(
    holding: { symbol: string; averagePrice: number; quantity: number },
    currentLivePrice: number,
    pnlPct: number,
    openedAtIso: string | null,
  ): Promise<boolean> {
    try {
      const endMs = Date.now();
      const startMs = endMs - 400 * 24 * 60 * 60 * 1000;
      const bars = await historicalDataGateway.getBars(holding.symbol, '1Day', startMs, endMs);
      if (bars.length < 5) return false; // let evaluateExit's own richer INSUFFICIENT_DATA path decide, but don't bother calling it on almost nothing

      const openedAtMs = openedAtIso ? new Date(openedAtIso).getTime() : null;
      const barsSinceEntry = openedAtMs && Number.isFinite(openedAtMs)
        ? bars.filter((b) => b.timestamp >= openedAtMs)
        : bars;
      const peakPriceSinceEntry = barsSinceEntry.length > 0
        ? Math.max(currentLivePrice, holding.averagePrice, ...barsSinceEntry.map((b) => b.high))
        : Math.max(currentLivePrice, holding.averagePrice);

      const evaluation = evaluateExit({
        symbol: holding.symbol,
        entryPrice: holding.averagePrice,
        currentPrice: currentLivePrice,
        peakPriceSinceEntry,
        quantity: holding.quantity,
        bars,
      });

      recordPortfolioDecision({
        symbol: holding.symbol,
        state: evaluation.decision === 'HOLD' ? 'HEALTHY' : 'WATCH',
        pnlPct,
        currentPrice: currentLivePrice,
        reason: `[ExitIntelligence] ${evaluation.reasoning}`,
      });

      if (evaluation.decision === 'TAKE_PROFIT' || evaluation.decision === 'EXIT' || evaluation.decision === 'EMERGENCY_EXIT') {
        console.log(`[PortfolioWorker] ExitIntelligence recommends ${evaluation.decision} on ${holding.symbol} (score ${evaluation.exitScore.toFixed(0)}/100)`);
        this.emitRiskExit({
          symbol: holding.symbol,
          currentPrice: currentLivePrice,
          pnlPct,
          confidence: evaluation.confidence,
          reasoning: `EXIT_CODE=EXIT_INTELLIGENCE_${evaluation.decision} ${evaluation.reasoning}`,
        });
      }
      return true;
    } catch (e) {
      console.warn(`[PortfolioWorker] ExitIntelligence evaluation failed for ${holding.symbol} (deferring to generic checks):`, (e as Error).message);
      return false;
    }
  }
}

export const portfolioMonitor = new PortfolioMonitorWorker();
