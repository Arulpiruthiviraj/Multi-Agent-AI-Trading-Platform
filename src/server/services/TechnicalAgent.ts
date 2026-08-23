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
import { classifyLightweightRegime, encodeRegime } from '../research/lightweightRegimeClassifier';

export class TechnicalProposerAgent {
  // Tick-driven via MARKET_DATA (MarketDataWorker WebSocket), not a standalone 60s timer.
  // Requires quantThresholds.technicalHistoryBars ticks before checkStrategies fires.
  private priceHistory: Record<string, number[]> = {};
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
  // M3 debounce (ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md): technicalEvaluationCooldownMs above only
  // throttles how often checkStrategies() re-runs - a still-true, unchanged signal used to
  // re-emit TRADE_IDEA_GENERATED every single cooldown period regardless, producing thousands of
  // near-duplicate rows for one real regime read. These two maps let emission additionally require
  // either a genuine indicator state-transition or technicalSignalCooldownMs since the last
  // emission of that SAME signal on that SAME symbol.
  private previousIndicators: Record<string, { rsi: number; macdHistogram: number }> = {};
  private lastEmittedAt: Record<string, Partial<Record<'momentumBreakout' | 'meanReversion' | 'overbought', number>>> = {};
  private readonly onMarketData = (data: { symbol: string, price: number, volume: number, timestamp: string }) => this.analyzeTick(data);
  private listening = false;
  private onConfluenceNudge = (payload: any) => {
    const symbol = typeof payload?.symbol === 'string' ? payload.symbol.toUpperCase() : '';
    if (!symbol || !this.priceHistory[symbol]) return;
    const history = this.priceHistory[symbol];
    if (history.length < quantThresholds.technicalHistoryBars) return;
    if (!isLiveIdeaGenerationEnabled() || !isPipelineAgentEnabled('TechnicalAgent')) return;
    this.lastEvaluatedAt[symbol] = 0;
    this.checkStrategies(symbol, history);
  };

  start() {
    if (this.listening) return;
    eventBus.subscribe('MARKET_DATA', this.onMarketData);
    eventBus.on(EVENTS.CAMPAIGN_CONFLUENCE_NUDGE, this.onConfluenceNudge);
    this.listening = true;
  }

  stop() {
    if (!this.listening) return;
    eventBus.unsubscribe('MARKET_DATA', this.onMarketData);
    eventBus.off(EVENTS.CAMPAIGN_CONFLUENCE_NUDGE, this.onConfluenceNudge);
    this.listening = false;
  }

  /**
   * Opportunity Feed / manual co-eval: seed rolling prices from live tick + historical closes
   * when needed, bypass emission debounce once, then run the same checkStrategies path.
   * Never fabricates indicator values — if history is too thin, returns honestly.
   */
  async evaluateOnDemand(symbol: string): Promise<{ status: string; emitted: boolean }> {
    const sym = symbol.toUpperCase();
    if (!isLiveIdeaGenerationEnabled() || !isPipelineAgentEnabled('TechnicalAgent')) {
      return { status: 'gated', emitted: false };
    }
    notePipelineAgentTick('TechnicalAgent');

    let history = this.priceHistory[sym] || [];
    const live = (await import('./MarketDataWorker')).marketDataWorker.getLatestPrice(sym);
    if (typeof live === 'number' && Number.isFinite(live) && live > 0) {
      history = [...history, live];
    }

    if (history.length < quantThresholds.technicalHistoryBars) {
      try {
        const { historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway');
        const endMs = Date.now();
        const startMs = endMs - 120 * 24 * 60 * 60 * 1000;
        await historicalDataGateway.ensureBars(sym, '1Day', startMs, endMs);
        const bars = await historicalDataGateway.getBars(sym, '1Day', startMs, endMs);
        const closes = bars.map((b) => b.close).filter((c) => typeof c === 'number' && c > 0);
        history = [...closes, ...(typeof live === 'number' && live > 0 ? [live] : [])];
      } catch (e: any) {
        return { status: `insufficient_history:${e?.message || e}`, emitted: false };
      }
    }

    if (history.length < quantThresholds.technicalHistoryBars) {
      return { status: `insufficient_history:${history.length}`, emitted: false };
    }

    // Keep the most recent window and clear debounce so this operator trigger can emit once.
    this.priceHistory[sym] = history.slice(-quantThresholds.technicalHistoryBars);
    this.lastEvaluatedAt[sym] = 0;
    delete this.previousIndicators[sym];
    delete this.lastEmittedAt[sym];

    this.checkStrategies(sym, this.priceHistory[sym]);
    const emitted = !!this.lastEmittedAt[sym] && Object.keys(this.lastEmittedAt[sym] || {}).length > 0;
    return { status: emitted ? 'emitted' : 'no_signal', emitted };
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

  /**
   * True when signal `key` on `symbol` should actually re-emit: either a genuine indicator
   * state-transition happened since the previous evaluation (RSI crossing its threshold, MACD
   * histogram sign flip), or technicalSignalCooldownMs has elapsed since this exact signal was
   * last emitted on this exact symbol. First-ever evaluation for a symbol (no previous snapshot,
   * no prior emission) always passes - there is nothing to debounce against yet.
   */
  private shouldEmitSignal(
    symbol: string,
    key: 'momentumBreakout' | 'meanReversion' | 'overbought',
    rsi: number,
    macdHistogram: number,
    now: number,
  ): boolean {
    const prev = this.previousIndicators[symbol];
    if (prev) {
      const crossed =
        key === 'momentumBreakout' ? (prev.macdHistogram <= 0 && macdHistogram > 0) || (prev.rsi <= 50 && rsi > 50)
        : key === 'meanReversion' ? prev.rsi >= 30 && rsi < 30
        : /* overbought */ prev.rsi <= 75 && rsi > 75;
      if (crossed) return true;
    }
    const lastEmitted = this.lastEmittedAt[symbol]?.[key];
    return lastEmitted === undefined || now - lastEmitted >= quantThresholds.technicalSignalCooldownMs;
  }

  private markEmitted(symbol: string, key: 'momentumBreakout' | 'meanReversion' | 'overbought', now: number): void {
    if (!this.lastEmittedAt[symbol]) this.lastEmittedAt[symbol] = {};
    this.lastEmittedAt[symbol][key] = now;
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
    // simplified proxy, with zero drift between live and replay. Emission debouncing below is
    // LIVE-ONLY (this class, not technicalSignal.ts) - replay's own research-clock cadence is a
    // different concept and must not be wall-clock-debounced.
    const { indicators, momentumBreakout, meanReversion, overbought } = evaluateTechnicalSignals(prices);
    const { rsi, sma20, sma50, macd, macdSignal, bbUpper, bbLower } = indicators;
    const macdHistogram = macd - macdSignal;
    // Phase 6 (ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md) - regime captured
    // from exactly this tick's own rolling price window, nothing later. Persisted onto
    // agent_predictions.regime via ReflectionEngine.logPrediction() below for by-regime analysis.
    const regime = encodeRegime(classifyLightweightRegime(prices));

    eventBus.emitCalculation(traceId, 'TechnicalEngine', symbol, { rsi, sma20, sma50, currentPrice, macd, bbUpper, bbLower });
    eventBus.emit(EVENTS.TECHNICAL_ANALYSIS_COMPLETED, { traceId, symbol, latencyMs: Date.now() - startedAt, rsi, sma20, sma50, currentPrice, macd, bbUpper, bbLower });

    if (momentumBreakout && this.shouldEmitSignal(symbol, 'momentumBreakout', rsi, macdHistogram, startedAt)) {
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
        regime,
      });
      this.markEmitted(symbol, 'momentumBreakout', startedAt);
      // Real bug found and fixed this pass: notePipelineAgentSuccess was only called after this
      // Momentum Breakout branch, not the Mean Reversion / Overbought branches below - a real,
      // successful SELL (overbought) or BUY (mean-reversion) signal still left the pipeline health
      // heartbeat's lastSuccessfulTickAt/currentState stale, misleading anything reading
      // getPipelineAgentSnapshot()/pipelineAgentHealth about whether this agent was actually alive.
      notePipelineAgentSuccess('TechnicalAgent');
    }

    if (meanReversion && this.shouldEmitSignal(symbol, 'meanReversion', rsi, macdHistogram, startedAt)) {
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
        regime,
      });
      this.markEmitted(symbol, 'meanReversion', startedAt);
      notePipelineAgentSuccess('TechnicalAgent');
    }

    if (overbought && this.shouldEmitSignal(symbol, 'overbought', rsi, macdHistogram, startedAt)) {
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
        regime,
      });
      this.markEmitted(symbol, 'overbought', startedAt);
      notePipelineAgentSuccess('TechnicalAgent');
    }

    this.previousIndicators[symbol] = { rsi, macdHistogram };
  }
}

export const technicalAgent = new TechnicalProposerAgent();
