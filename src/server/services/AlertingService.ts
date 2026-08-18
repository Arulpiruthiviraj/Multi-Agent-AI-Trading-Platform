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
 *
 * Fault tolerance (ARGUS): also dispatches to ALERT_WEBHOOK_URL when set (Discord/Telegram
 * compatible JSON). Alerts on kill-switch state, OMS ORDER_EXECUTED, and process boot.
 * ==========================================================
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { triggerWebhooks, WebhookEvent } from '../routes/webhooks';
import { SIGNIFICANT_MISMATCH_DOLLARS } from './PortfolioReconciliation';
import { tradingSafety } from '../config/tradingSafety';

const ALERT_COOLDOWN_MS = tradingSafety.alertingCooldownMs;

async function dispatchEnvAlertWebhook(title: string, message: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🚨 *[ARGUS]* *${title}*\n> ${message}\n_Time: ${new Date().toISOString()}_`,
      }),
    });
  } catch (e) {
    console.error('[AlertingService] ALERT_WEBHOOK_URL dispatch failed', e);
  }
}

export class AlertingService {
  private lastAlertAt = new Map<string, number>();
  private started = false;
  private bootAlertSent = false;

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
    await dispatchEnvAlertWebhook(event.title, event.message);
  }

  /** Called once after HTTP server is listening — operator visibility on every boot. */
  alertProcessBoot(extra?: Record<string, unknown>) {
    if (this.bootAlertSent) return;
    this.bootAlertSent = true;
    const mode =
      process.env.ARGUS_TRADING_MODE ||
      (process.env.PAPER_TRADING_ONLY === 'true' ? 'PAPER' : 'SIMULATOR');
    this.send({
      type: 'process_boot',
      title: 'Argus process started',
      message: `Backend boot complete (${mode} mode). PID ${process.pid}.`,
      details: { pid: process.pid, nodeEnv: process.env.NODE_ENV, ...extra },
    });
  }

  start() {
    if (this.started) return;
    this.started = true;

    eventBus.on('RECONCILIATION_MISMATCH', (payload: any) => {
      const worst = payload?.worstImpactDollars ?? 0;
      if (worst < SIGNIFICANT_MISMATCH_DOLLARS) return;
      if (!this.shouldAlert('reconciliation_mismatch')) return;
      this.send({
        type: 'reconciliation_mismatch',
        title: 'Portfolio reconciliation mismatch',
        message: `A ~$${Number(worst).toFixed(2)} mismatch vs ${payload?.broker ?? 'the active broker'} was found - trading has been paused pending manual review.`,
        details: payload,
      });
    });

    eventBus.on(EVENTS.MARKET_DATA_DISCONNECTED, (payload: any) => {
      if (!this.shouldAlert('market_data_disconnected')) return;
      this.send({
        type: 'market_data_disconnected',
        title: 'Market data disconnected',
        message: `Real-time market data feed disconnected: ${payload?.reason ?? 'unknown reason'}.`,
        details: payload,
      });
    });

    eventBus.on(EVENTS.TRADING_STATE_CHANGED, (payload: any) => {
      if (!payload || payload.toState === 'TRADING_ENABLED') return;
      if (payload.toState !== 'TRADING_PAUSED' && payload.toState !== 'EMERGENCY_STOP') return;
      if (!this.shouldAlert(`trading_state_changed:${payload.toState}`)) return;
      this.send({
        type: 'trading_state_changed',
        title: `Trading ${payload.toState === 'EMERGENCY_STOP' ? 'emergency-stopped' : 'paused'}`,
        message: `${payload.fromState} -> ${payload.toState}. Reason: ${payload.reason}`,
        details: payload,
      });
    });

    eventBus.on(EVENTS.ORDER_EXECUTED, (order: any) => {
      if (!order || order.status !== 'FILLED') return;
      const env = String(order.executionEnvironment || '').toUpperCase();
      if (env === 'REPLAY' || env === 'BACKTEST' || env === 'SIMULATION') return;
      const key = `order_executed:${order.symbol}:${order.side}:${order.id ?? order.traceId ?? 'unknown'}`;
      if (!this.shouldAlert(key)) return;
      this.send({
        type: 'order_executed',
        title: `Order filled: ${order.side} ${order.symbol}`,
        message: `${order.quantity ?? '?'} @ ${order.price ?? order.averageFillPrice ?? '?'} (${order.agent ?? 'OMS'})`,
        details: order,
      });
    });

    eventBus.on(EVENTS.AI_PROVIDERS_EXHAUSTED, (payload: any) => {
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
