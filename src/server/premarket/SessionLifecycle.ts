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
import { classifyMarketSession, minutesInTimezone, weekdayInTimezone, type MarketSession } from '../replay/marketSession';
import { replaySafety } from '../replay/replaySafety';

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
  /** Stable per-trading-day identifier. Deliberately just a deterministic function of tradingDate
   *  (not a random UUID) - two evaluations on the same trading day must agree on this value. */
  sessionId: string;
  /** True whenever extended-hours trading is possible under this classifier's own PRE_MARKET/
   *  AFTER_HOURS branches - i.e. marketSession is PRE_MARKET or AFTER_HOURS. False for REGULAR
   *  (extended-hours logic doesn't apply) and for CLOSED (no session of any kind is active). */
  isExtendedHours: boolean;
  /** True on any weekday. Deliberately holiday-blind, matching every other session representation
   *  in this codebase (classifyMarketSession itself has no holiday table) - see
   *  docs/architecture/ARGUS_SESSION_AWARE_TRADING_ARCHITECTURE.md §2.3 for why. A real
   *  holiday-aware value would require Alpaca's /v2/clock, which this module may not import
   *  (RiskEngine.ts owns that call and this directory is architecturally barred from RiskEngine).
   *  False on Saturday/Sunday only. */
  isTradingDay: boolean;
  /** Signed minutes to/since the 09:30 ET regular-session open and 16:00 ET close, from the same
   *  fixed minute-of-day table classifyMarketSession() itself uses (replaySafety.json) - honestly
   *  holiday-blind like every field above. Positive minutesToOpen means the open hasn't happened
   *  yet today; negative means it already has. Same convention for minutesToClose. null on a
   *  non-trading day (Sat/Sun), since "minutes to an open that isn't happening" has no honest value. */
  minutesToOpen: number | null;
  minutesSinceOpen: number | null;
  minutesToClose: number | null;
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
  const nowMs = now.getTime();
  const marketSession = classifyMarketSession(nowMs, TRADING_TIMEZONE, true);
  const tradingDate = getTradingDateStr(now);
  const weekday = weekdayInTimezone(nowMs, TRADING_TIMEZONE);
  const isTradingDay = weekday !== 'Sat' && weekday !== 'Sun';
  const mins = isTradingDay ? minutesInTimezone(nowMs, TRADING_TIMEZONE) : null;

  return {
    marketSession,
    appState: MARKET_SESSION_TO_APP_STATE[marketSession],
    tradingDate,
    evaluatedAt: now.toISOString(),
    sessionId: `argus-session-${tradingDate}`,
    isExtendedHours: marketSession === 'PRE_MARKET' || marketSession === 'AFTER_HOURS',
    isTradingDay,
    minutesToOpen: mins == null ? null : replaySafety.regularSessionStartMinutes - mins,
    minutesSinceOpen: mins == null ? null : mins - replaySafety.regularSessionStartMinutes,
    minutesToClose: mins == null ? null : replaySafety.regularSessionEndMinutes - mins,
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
        // liveNow's derived fields (sessionId/isExtendedHours/isTradingDay/minutesTo*) reflect
        // NOW, not the historical persisted evaluatedAt - correct, since a restored snapshot is
        // about to be revalidated against real conditions on the very next evaluate() anyway (see
        // this method's own doc comment above).
        this.current = {
          ...liveNow,
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

/**
 * Read-only refinement of appState using real TradePlan existence/status for the snapshot's own
 * tradingDate - closes the gap this file's own header flagged: PLAN_BUILDING/PLAN_READY/
 * OPEN_REVALIDATION were declared in ApplicationSessionState but never assigned by any code path
 * (see docs/architecture/ARGUS_PREMARKET_GAP_ANALYSIS.md §2).
 *
 * Deliberately NOT folded into SessionLifecycleManager.evaluate()/`current`: that method's own
 * transition-detection (`prev.appState !== next.appState`) compares against its OWN prior
 * deterministic computation, and mutating `current` to a refined value here would make every
 * subsequent tick's deterministic recomputation look like a spurious transition back to the
 * unrefined state - a real correctness bug, not a style preference. Instead this is a pure,
 * additive READ function: call it wherever a caller wants the richer state (the runtime API route
 * does), while the worker's own event-emission semantics stay exactly as tested above, untouched.
 *
 * `getTradePlansForDate` is a plain read-only DB query (no OMS/RiskEngine/BrokerManager/broker
 * adapter, no placeOrder, no emitTradeIdea) - satisfies premarketArchitectureBoundary.test.ts's
 * literal checks exactly as SessionLifecycle.ts's existing DB persistence calls already do.
 * Fails closed to the unrefined snapshot on any error (DB unavailable, import failure, etc.) -
 * never throws, never blocks a caller that just wants basic session info.
 */
export async function getRefinedSnapshot(
  snapshot: SessionLifecycleSnapshot = sessionLifecycleWorker.getSnapshot(),
): Promise<SessionLifecycleSnapshot> {
  if (snapshot.marketSession !== 'PRE_MARKET' && snapshot.marketSession !== 'REGULAR') return snapshot;
  try {
    const { getTradePlansForDate } = await import('../continuous/TradePlanBuilder');
    const plans = await getTradePlansForDate(snapshot.tradingDate);
    if (snapshot.marketSession === 'PRE_MARKET') {
      return { ...snapshot, appState: plans.length === 0 ? 'PLAN_BUILDING' : 'PLAN_READY' };
    }
    const stillRevalidating = plans.some((p) => p.status === 'READY' || p.status === 'VALID' || p.status === 'REVALIDATING');
    return stillRevalidating ? { ...snapshot, appState: 'OPEN_REVALIDATION' } : snapshot;
  } catch (e) {
    console.error('[SessionLifecycle] getRefinedSnapshot() failed - returning unrefined snapshot', e);
    return snapshot;
  }
}
