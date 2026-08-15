/**
 * ==========================================================
 * Module: AIFailureCircuitBreaker
 *
 * Purpose:
 * Phase 16M (ARGUS_PHASE16_READINESS_REPORT.md) - closes a real, previously-documented gap:
 * "maximum AI failures" was never enforced as a hard safety ceiling anywhere. `AI_PROVIDERS_EXHAUSTED`
 * (all providers failed for one agent call) already existed and `AlertingService` already alerts on
 * it, but nothing ever ACTED on repeated exhaustion - Argus would just keep silently falling back to
 * "no trade idea" for every affected agent call, indefinitely, with no operator-visible pause.
 *
 * Deliberately time-windowed, not a strict "N consecutive calls" counter - AIRouter has no
 * "call succeeded" event today (only DB rows in `ai_calls`), so a true consecutive-failure count
 * would need new instrumentation at every success call site across every agent. A rolling window
 * of exhaustion EVENTS (mirrors AlertingService's own cooldown pattern) is honest about what it
 * actually measures and requires no changes anywhere else.
 *
 * Mirrors RestrictedLiveMode.ts's own scope discipline: only ever active in real LIVE trading
 * (`tradingEngine.state.tradingMode === 'LIVE'`) - a no-op for paper trading, which is the entirety
 * of real usage in this environment today. Reuses the same real pause mechanism Phase 1 wired up
 * for reconciliation mismatches (`tradingEngine.setTradingState('TRADING_PAUSED', ...)`) - never a
 * new parallel safety system.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { tradingEngine } from '../engines/TradingEngine';
import { tradingSafety } from '../config/tradingSafety';

export const AI_FAILURE_WINDOW_MS = tradingSafety.aiFailureWindowMs;
export const AI_FAILURE_THRESHOLD_FOR_LIVE_PAUSE = tradingSafety.aiFailureThresholdForLivePause;

export class AIFailureCircuitBreaker {
  private exhaustionTimestamps: number[] = [];
  private started = false;

  private recordAndCheck(): boolean {
    const now = Date.now();
    this.exhaustionTimestamps.push(now);
    this.exhaustionTimestamps = this.exhaustionTimestamps.filter(t => now - t < AI_FAILURE_WINDOW_MS);
    return this.exhaustionTimestamps.length >= AI_FAILURE_THRESHOLD_FOR_LIVE_PAUSE;
  }

  start() {
    if (this.started) return;
    this.started = true;

    eventBus.on('AI_PROVIDERS_EXHAUSTED', async (payload: any) => {
      const tripped = this.recordAndCheck();
      if (!tripped) return;
      if (tradingEngine.state.tradingMode !== 'LIVE') return; // no-op for paper trading
      if (tradingEngine.state.tradingState !== 'TRADING_ENABLED') return; // already paused/stopped - avoid a redundant transition

      await tradingEngine.setTradingState('TRADING_PAUSED', {
        reason: `${this.exhaustionTimestamps.length} AI-provider-exhaustion events within ${AI_FAILURE_WINDOW_MS / 60000} minutes (last: ${payload?.agentType ?? 'unknown agent'}). Every configured AI provider is failing - pausing real-money trading pending manual review, rather than continuing to trade on agents silently degraded to no-AI-input.`,
        actor: 'system:AIFailureCircuitBreaker',
      });
    });
  }

  /** Test-only: clears in-memory state between isolated test runs. */
  resetForTests() {
    this.exhaustionTimestamps = [];
  }
}

export const aiFailureCircuitBreaker = new AIFailureCircuitBreaker();
