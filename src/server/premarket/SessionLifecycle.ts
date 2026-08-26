/**
 * Session Lifecycle — Stage 1 of the market-day intelligence cycle (Phase A).
 *
 * Promotes the existing, already-correct `classifyMarketSession()` (previously imported only by
 * the replay engine) into the live runtime, and layers a small application-level state on top of
 * it. This module is pure observability/state this stage — it does not scan, rank, plan, or emit
 * a trade idea. Later stages (broad-universe activation, candidate ranking, TradePlan persistence,
 * open revalidation, after-close review) attach real behavior to these states; this stage only
 * makes "what part of the trading day is it, and what should Argus conceptually be doing right
 * now" a first-class, observable, testable fact instead of an implicit assumption.
 *
 * Architecture boundary (enforced by premarketArchitectureBoundary.test.ts, same static-scan
 * pattern as evolutionBoundary.test.ts from the Strategy Evolution Engine): nothing under
 * src/server/premarket/ may import ChiefTraderAgent, RiskEngine, OrderManagement, BrokerManager,
 * or any broker adapter; place a broker order directly; inject an idea into the live pipeline;
 * or reference the chief-approval transition event. This module only imports EventBus (to
 * publish observability events) and read-only calendar/session helpers.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { getTradingDateStr, TRADING_TIMEZONE } from '../core/TradingCalendar';
import { classifyMarketSession, type MarketSession } from '../replay/marketSession';

export type ApplicationSessionState =
  | 'IDLE'
  | 'RESEARCHING'
  | 'PLAN_BUILDING'
  | 'PLAN_READY'
  | 'OPEN_REVALIDATION'
  | 'INTRADAY'
  | 'CLOSE_REVIEW';

export interface SessionLifecycleSnapshot {
  marketSession: MarketSession;
  appState: ApplicationSessionState;
  tradingDate: string;
  evaluatedAt: string;
}

/**
 * Deterministic, stage-1-safe mapping from real market session to application state. Later
 * stages will refine this (e.g. RESEARCHING -> PLAN_BUILDING -> PLAN_READY happen only once
 * broad-universe scanning and candidate ranking exist; OPEN_REVALIDATION only once TradePlans
 * exist to revalidate). For now every market session maps to exactly one deterministic app
 * state so "what state did Argus boot into" is provable by a pure function, matching the
 * Phase M tests for boot-time classification.
 */
const MARKET_SESSION_TO_APP_STATE: Record<MarketSession, ApplicationSessionState> = {
  PRE_MARKET: 'RESEARCHING',
  REGULAR: 'INTRADAY',
  AFTER_HOURS: 'CLOSE_REVIEW',
  CLOSED: 'IDLE',
};

/** Pure — no timers, no EventBus, safe to unit test directly. */
export function evaluateSessionLifecycle(now: Date = new Date()): SessionLifecycleSnapshot {
  const marketSession = classifyMarketSession(now.getTime(), TRADING_TIMEZONE, true);
  return {
    marketSession,
    appState: MARKET_SESSION_TO_APP_STATE[marketSession],
    tradingDate: getTradingDateStr(now),
    evaluatedAt: now.toISOString(),
  };
}

class SessionLifecycleManager {
  private intervalId: NodeJS.Timeout | null = null;
  private current: SessionLifecycleSnapshot | null = null;
  /** Trading date (YYYY-MM-DD) we last fired PREMARKET_SESSION_STARTED for - prevents refiring
   *  every eval tick while still inside the same PRE_MARKET window. */
  private lastPremarketFiredForDate: string | null = null;

  getSnapshot(): SessionLifecycleSnapshot {
    return this.current ?? evaluateSessionLifecycle();
  }

  /** Re-evaluate now; emits observability events on a real state or session-day transition. */
  evaluate(now: Date = new Date()): SessionLifecycleSnapshot {
    const next = evaluateSessionLifecycle(now);
    const prev = this.current;
    this.current = next;

    if (!prev || prev.appState !== next.appState || prev.marketSession !== next.marketSession) {
      // Emitted key is "marketPhase", not "marketSession" — SecretRedaction.ts's SENSITIVE_KEY
      // regex matches any key containing the substring "session" (to catch real sessionId/
      // sessionToken values) and was blanket-redacting this harmless enum in the persisted
      // event record (found live, 2026-08-26 forensic audit). The internal SessionLifecycleSnapshot
      // type keeps its own `marketSession` field name; only the emitted payload key changes.
      eventBus.emit(EVENTS.SESSION_LIFECYCLE_STATE_CHANGED, {
        from: prev ? { marketPhase: prev.marketSession, appState: prev.appState } : null,
        to: { marketPhase: next.marketSession, appState: next.appState },
        tradingDate: next.tradingDate,
        at: next.evaluatedAt,
      });
    }

    if (next.marketSession === 'PRE_MARKET' && this.lastPremarketFiredForDate !== next.tradingDate) {
      this.lastPremarketFiredForDate = next.tradingDate;
      eventBus.emit(EVENTS.PREMARKET_SESSION_STARTED, {
        tradingDate: next.tradingDate,
        at: next.evaluatedAt,
      });
    }

    return next;
  }

  start(): void {
    if (this.intervalId) return;
    this.evaluate();
    this.intervalId = setInterval(() => {
      try {
        this.evaluate();
      } catch (e) {
        console.error('[SessionLifecycle] evaluate() failed', e);
      }
    }, runtimeIntervals.sessionLifecycleEvalMs);
    console.log(
      `[SessionLifecycle] Started (eval every ${runtimeIntervals.sessionLifecycleEvalMs}ms). `
      + `Boot state: marketSession=${this.current?.marketSession} appState=${this.current?.appState}.`,
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Test-only: clear cached state so a fresh evaluate() reflects a mocked clock cleanly. */
  resetForTests(): void {
    this.stop();
    this.current = null;
    this.lastPremarketFiredForDate = null;
  }
}

export const sessionLifecycleWorker = new SessionLifecycleManager();
