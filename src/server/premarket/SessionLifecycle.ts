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

  /**
   * Phase 4J (Session Lifecycle persistence, 2026-08-27). Persists every real evaluate() result
   * from the running worker so a restart can recover genuine prior-state context instead of
   * always emitting `from: null`. Deliberately NOT called from the plain `evaluate()` method used
   * directly by unit tests - those must stay pure/DB-free, since they run without an isolated
   * ARGUS_DB_PATH and would otherwise write into the real data/argus.db (DEF-18 territory).
   */
  private async persistSnapshot(snapshot: SessionLifecycleSnapshot): Promise<void> {
    try {
      const { db } = await import('../db');
      const { sessionLifecycleSnapshots } = await import('../db/schema');
      await db.insert(sessionLifecycleSnapshots).values({
        tradingDate: snapshot.tradingDate,
        marketSession: snapshot.marketSession,
        appState: snapshot.appState,
        premarketFiredForDate: this.lastPremarketFiredForDate,
        evaluatedAt: snapshot.evaluatedAt,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[SessionLifecycle] failed to persist snapshot (does not affect live evaluation)', e);
    }
  }

  /**
   * Restores in-memory `current`/`lastPremarketFiredForDate` from the latest persisted row for
   * TODAY's trading date only - a prior-day row is not trustworthy as "previous state" and is
   * deliberately left unused (honest `from: null` is correct in that case). This never sets what
   * the CURRENT state is; the next evaluate() call always re-derives that live from
   * classifyMarketSession(), so a persisted row is revalidated against real conditions, never
   * blindly trusted.
   */
  private async hydrateFromPersistedState(now: Date = new Date()): Promise<void> {
    try {
      const liveNow = evaluateSessionLifecycle(now);
      const { db } = await import('../db');
      const { sessionLifecycleSnapshots } = await import('../db/schema');
      const { eq, desc } = await import('drizzle-orm');
      const rows = await db.select().from(sessionLifecycleSnapshots)
        .where(eq(sessionLifecycleSnapshots.tradingDate, liveNow.tradingDate))
        .orderBy(desc(sessionLifecycleSnapshots.evaluatedAt))
        .limit(1);
      if (rows.length > 0) {
        const row = rows[0];
        this.current = {
          marketSession: row.marketSession as MarketSession,
          appState: row.appState as ApplicationSessionState,
          tradingDate: row.tradingDate,
          evaluatedAt: row.evaluatedAt,
        };
        this.lastPremarketFiredForDate = row.premarketFiredForDate;
        console.log(
          `[SessionLifecycle] Restored same-day prior state from persistence: `
          + `marketSession=${row.marketSession} appState=${row.appState} (last evaluated ${row.evaluatedAt}).`,
        );
      } else {
        console.log('[SessionLifecycle] No same-day persisted state found - starting fresh (from: null is honest here).');
      }
    } catch (e) {
      console.error('[SessionLifecycle] failed to hydrate persisted state - starting fresh', e);
    }
  }

  /** `now` is test-only (mirrors MarketDataWorker.setNowForTests's pattern) - production callers omit it. */
  async start(now: Date = new Date()): Promise<void> {
    if (this.intervalId) return;
    await this.hydrateFromPersistedState(now);
    const first = this.evaluate(now);
    void this.persistSnapshot(first);
    this.intervalId = setInterval(() => {
      try {
        const next = this.evaluate();
        void this.persistSnapshot(next);
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
