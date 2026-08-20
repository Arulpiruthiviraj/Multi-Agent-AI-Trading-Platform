/**
 * ==========================================================
 * Module:
 * TechnicalAgent.ts
 *
 * Purpose:
 * Core implementation and logic for the TechnicalAgent.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for TechnicalAgent
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
import { EVENTS } from '../core/eventNames';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { quantThresholds } from '../config/quantThresholds';
import { generateTraceId } from '../core/traceId';
import { notePipelineAgentGated, notePipelineAgentSuccess, notePipelineAgentTick } from '../core/pipelineAgentHealth';
import { evaluateTechnicalSignals } from './technicalSignal';

export class TechnicalProposerAgent {
  // Tick-driven via MARKET_DATA (MarketDataWorker WebSocket), not a standalone 60s timer.
  // Requires quantThresholds.technicalHistoryBars ticks before checkStrategies fires.
  private priceHistory: Record<string, number[]> = {};
  private listening = false;
  // Real bug found and fixed (2026-08-18): priceHistory is capped at technicalHistoryBars via
  // shift(), so `history.length === technicalHistoryBars` is true on every tick forever once
  // warmup completes - checkStrategies() (and everything downstream: TRADE_IDEA_GENERATED,
  // ChiefTrader consensus, a real AI debate call) had no per-symbol cooldown at all. Confirmed
  // live: with trading enabled, SPY/QQQ/IWM/DIA (high tick-rate benchmark ETFs) produced 543
  // TRADE_IDEA_GENERATED and 15,183 AI_CALL rows in 60 seconds - each AI_CALL is a real DB write
  // plus provider round-trip, and at that rate it saturated the event loop and crashed the
  // process (observed: /health itself took 6-77s to respond, then the process exited). This does
  // not change the strategy logic - only how often it's allowed to re-run per symbol.
  private lastEvaluatedAt: Record<string, number> = {};
  private readonly onMarketData = (data: { symbol: string, price: number, volume: number, timestamp: string }) => this.analyzeTick(data);

  start() {
    if (this.listening) return;
    eventBus.subscribe('MARKET_DATA', this.onMarketData);
    this.listening = true;
  }

  stop() {
    if (!this.listening) return;
    eventBus.unsubscribe('MARKET_DATA', this.onMarketData);
    this.listening = false;
  }

  analyzeTick(data: { symbol: string, price: number, volume: number, timestamp: string }) {
    notePipelineAgentTick('TechnicalAgent');
    if (!isLiveIdeaGenerationEnabled()) {
      notePipelineAgentGated('TechnicalAgent');
      return;
    }
    if (!isPipelineAgentEnabled('TechnicalAgent')) {
      notePipelineAgentGated('TechnicalAgent');
      return;
    }

    if (!this.priceHistory[data.symbol]) {
      this.priceHistory[data.symbol] = [];
    }
    const history = this.priceHistory[data.symbol];
    history.push(data.price);
    
    if (history.length > quantThresholds.technicalHistoryBars) {
      history.shift();
    }

    if (history.length === quantThresholds.technicalHistoryBars) {
      const now = Date.now();
      const last = this.lastEvaluatedAt[data.symbol] ?? 0;
      if (now - last < quantThresholds.technicalEvaluationCooldownMs) return;
      this.lastEvaluatedAt[data.symbol] = now;
      this.checkStrategies(data.symbol, history);
    }
  }

  private checkStrategies(symbol: string, prices: number[]) {
    const currentPrice = prices[prices.length - 1];
    const traceId = generateTraceId(symbol);
    const startedAt = Date.now();

    // Real STARTED/COMPLETED bracket for live animation (previously only Kronos had one) -
    // TechnicalAgent's computation is synchronous and fast, but the pair still lets the UI show
    // exactly when this node began working versus when it produced a real result.
    eventBus.emit(EVENTS.TECHNICAL_ANALYSIS_STARTED, { traceId, symbol, timestamp: new Date(startedAt).toISOString() });

    // Indicator math + the three strategy rules live in technicalSignal.ts - a pure extraction
    // (behavior-preserving, see TechnicalAgent.checkStrategies-vs-technicalSignal.test.ts) so
    // Historical Evaluation replay can reuse the exact same deterministic logic instead of a
    // simplified proxy, with zero drift between live and replay.
    const { indicators, momentumBreakout, meanReversion, overbought } = evaluateTechnicalSignals(prices);
    const { rsi, sma20, sma50, macd, macdSignal, bbUpper, bbLower } = indicators;

    eventBus.emitCalculation(traceId, 'TechnicalEngine', symbol, { rsi, sma20, sma50, currentPrice, macd, bbUpper, bbLower });
    eventBus.emit(EVENTS.TECHNICAL_ANALYSIS_COMPLETED, { traceId, symbol, latencyMs: Date.now() - startedAt, rsi, sma20, sma50, currentPrice, macd, bbUpper, bbLower });

    if (momentumBreakout) {
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: momentumBreakout.side,
        confidence: momentumBreakout.confidence,
        currentPrice,
        reasoning: momentumBreakout.reasoning,
        agent: "TechnicalAgent",
        latencyMs: Date.now() - startedAt,
        indicatorsSnapshot: { rsi, sma20, sma50, macd, macdSignal, bbUpper, bbLower },
      });
      // Real bug found and fixed this pass: notePipelineAgentSuccess was only called after this
      // Momentum Breakout branch, not the Mean Reversion / Overbought branches below - a real,
      // successful SELL (overbought) or BUY (mean-reversion) signal still left the pipeline health
      // heartbeat's lastSuccessfulTickAt/currentState stale, misleading anything reading
      // getPipelineAgentSnapshot()/pipelineAgentHealth about whether this agent was actually alive.
      notePipelineAgentSuccess('TechnicalAgent');
    }

    if (meanReversion) {
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: meanReversion.side,
        confidence: meanReversion.confidence,
        currentPrice,
        reasoning: meanReversion.reasoning,
        agent: "TechnicalAgent",
        latencyMs: Date.now() - startedAt,
        indicatorsSnapshot: { rsi, sma20, sma50, macd, bbUpper, bbLower },
      });
      notePipelineAgentSuccess('TechnicalAgent');
    }

    if (overbought) {
      eventBus.emitTradeIdea({
        traceId,
        symbol,
        side: overbought.side,
        confidence: overbought.confidence,
        currentPrice,
        reasoning: overbought.reasoning,
        agent: "TechnicalAgent",
        latencyMs: Date.now() - startedAt,
        indicatorsSnapshot: { rsi, sma20, sma50, macd, bbUpper, bbLower },
      });
      notePipelineAgentSuccess('TechnicalAgent');
    }
  }
}

export const technicalAgent = new TechnicalProposerAgent();
