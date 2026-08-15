/**
 * ==========================================================
 * Module: AlertingService
 *
 * Purpose:
 * Phase 12 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md). Real operator alerting for CRITICAL events -
 * previously these either had no real consumer at all (MARKET_DATA_DISCONNECTED/GAP,
 * TRADING_STATE_CHANGED didn't exist as an event, AI_PROVIDERS_EXHAUSTED didn't exist), or only
 * produced a `console.warn`/DB row (RECONCILIATION_MISMATCH) - confirmed by the current audit
 * (FINAL_ANALYSIS.md Section 30.22): "Do not rely only on console logs."
 *
 * Deliberately reuses the existing, already-real, already-tested `triggerWebhooks()` mechanism
 * (`src/server/routes/webhooks.ts`) rather than inventing a second notification channel - that
 * function had real Slack/Discord/generic dispatch logic and a real CRUD-managed webhook list, but
 * was never actually called by anything (its own file's header comment even mischaracterized where
 * it was called from). This is genuinely the single biggest "wire an already-built thing up" fix
 * in this entire phase.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { triggerWebhooks, WebhookEvent } from '../routes/webhooks';
import { SIGNIFICANT_MISMATCH_DOLLARS } from './PortfolioReconciliation';
import { tradingSafety } from '../config/tradingSafety';

const ALERT_COOLDOWN_MS = tradingSafety.alertingCooldownMs;

export class AlertingService {
  private lastAlertAt = new Map<string, number>();
  private started = false;

  private shouldAlert(key: string): boolean {
    const last = this.lastAlertAt.get(key);
    const now = Date.now();
    if (last && now - last < ALERT_COOLDOWN_MS) return false;
    this.lastAlertAt.set(key, now);
    return true;
  }

  private async send(event: WebhookEvent) {
    console.error(`[AlertingService] CRITICAL: ${event.title} - ${event.message}`);
    try {
      await triggerWebhooks(event);
    } catch (e) {
      console.error('[AlertingService] Failed to dispatch webhook alert', e);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;

    eventBus.on('RECONCILIATION_MISMATCH', (payload: any) => {
      const worst = payload?.worstImpactDollars ?? 0;
      if (worst < SIGNIFICANT_MISMATCH_DOLLARS) return; // a small timing drift isn't alert-worthy
      if (!this.shouldAlert('reconciliation_mismatch')) return;
      this.send({
        type: 'reconciliation_mismatch',
        title: 'Portfolio reconciliation mismatch',
        message: `A ~$${Number(worst).toFixed(2)} mismatch vs ${payload?.broker ?? 'the active broker'} was found - trading has been paused pending manual review.`,
        details: payload,
      });
    });

    eventBus.on('MARKET_DATA_DISCONNECTED', (payload: any) => {
      if (!this.shouldAlert('market_data_disconnected')) return;
      this.send({
        type: 'market_data_disconnected',
        title: 'Market data disconnected',
        message: `Real-time market data feed disconnected: ${payload?.reason ?? 'unknown reason'}.`,
        details: payload,
      });
    });

    eventBus.on('TRADING_STATE_CHANGED', (payload: any) => {
      if (!payload || payload.toState === 'TRADING_ENABLED') return; // resuming trading isn't itself alert-worthy
      if (!this.shouldAlert(`trading_state_changed:${payload.toState}`)) return;
      this.send({
        type: 'trading_state_changed',
        title: `Trading ${payload.toState === 'EMERGENCY_STOP' ? 'emergency-stopped' : 'paused'}`,
        message: `${payload.fromState} -> ${payload.toState}. Reason: ${payload.reason}`,
        details: payload,
      });
    });

    eventBus.on('AI_PROVIDERS_EXHAUSTED', (payload: any) => {
      if (!this.shouldAlert(`ai_providers_exhausted:${payload?.agentType ?? 'unknown'}`)) return;
      this.send({
        type: 'ai_providers_exhausted',
        title: `All AI providers unavailable for ${payload?.agentType ?? 'an agent'}`,
        message: `Every configured AI provider failed. Last error: ${payload?.lastError ?? 'unknown'}. That agent's decisions default to no trade idea, not a fabricated one.`,
        details: payload,
      });
    });
  }
}

export const alertingService = new AlertingService();
