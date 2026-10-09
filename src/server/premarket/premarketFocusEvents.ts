/**
 * Pre-market focus engine events (2026-10-06, workstream D, local-only).
 *
 * - PREMARKET_CANDIDATE_SCORED: emitted once per scored candidate with a
 *   BOUNDED decomposition payload (top-N contributing components, rounded
 *   numbers, no unbounded arrays).
 * - PREMARKET_REFRESH_COMPLETED: emitted by TradePlanBuilder at the end of
 *   every completed refresh cycle (initial build + each scheduled /
 *   event-driven refresh — see emitPremarketRefreshCompleted below) with
 *   { tradingDate, refreshVersion, refreshedAt, planCount, at }; this module
 *   subscribes and regenerates the focus report DEFENSIVELY (a subscriber must
 *   never throw into the bus — see EventBus.isolation.test.ts precedent; the
 *   bus also isolates listeners, this is defense in depth).
 *
 * Event-name home: the canonical registry is config/eventNames.json, but these
 * two names are defined here because the refresh emitter (TradePlanBuilder)
 * emits them via the helpers in this module rather than through the catalog.
 * A follow-up may register them in config/eventNames.json and re-export them
 * from EVENTS here so there is a single source of truth. The string values
 * are stable either way.
 *
 * Observability path (verified 2026-10-06): DISCOVERY_CANDIDATE_ADMITTED
 * reaches observability_events via a DIRECT structuredLogger.info() call in
 * discoveryCandidateLedger.ts — NOT through the EventBus wildcard bridge
 * (instrumentEventBus.ts), which persists only a whitelisted field subset of
 * each bus payload (symbol/reason/source/stage/...). A decomposition payload
 * would not survive that whitelist, so emitPremarketCandidateScored() does
 * BOTH: eventBus.emit() for live subscribers (the bridge persists a compact
 * symbol+tier+total row from whitelisted fields), and a direct
 * structuredLogger.info('premarket_candidate_scored', ...) carrying the full
 * bounded decomposition — the same proven pattern as the discovery ledger.
 */
import { eventBus } from '../core/EventBus';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

export const PREMARKET_CANDIDATE_SCORED = 'PREMARKET_CANDIDATE_SCORED';
export const PREMARKET_REFRESH_COMPLETED = 'PREMARKET_REFRESH_COMPLETED';

export interface ScoredComponentContribution {
  component: string;
  score: number;
  weight: number;
  contribution: number;
}

export interface PremarketCandidateScoredPayload {
  symbol: string;
  tradingDate: string;
  refreshVersion: number;
  tier: string;
  total: number;
  topContributions: ScoredComponentContribution[];
  inputsMissing: string[];
  dataFresh: boolean;
  scoredAt: string;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Emit PREMARKET_CANDIDATE_SCORED for one scored candidate. Never throws:
 * observability must not break scoring/reporting. Bounded: at most
 * report.topContributionsKept contributions, numbers rounded to
 * report.roundDecimals, inputsMissing as-is (bounded by the fixed input
 * field set).
 */
export function emitPremarketCandidateScored(args: {
  symbol: string;
  tradingDate: string;
  refreshVersion: number;
  tier: string;
  total: number;
  components: Record<string, number>;
  weights: Record<string, number>;
  inputsMissing: string[];
  dataFresh: boolean;
  scoredAt: string;
  topN: number;
  roundDecimals: number;
}): void {
  try {
    const contributions: ScoredComponentContribution[] = Object.keys(args.components)
      .map((component) => {
        const score = args.components[component] ?? 0;
        const weight = args.weights[component] ?? 0;
        return {
          component,
          score: roundTo(score, args.roundDecimals),
          weight: roundTo(weight, args.roundDecimals),
          contribution: roundTo(weight * score, args.roundDecimals),
        };
      })
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, Math.max(1, args.topN));

    const payload: PremarketCandidateScoredPayload = {
      symbol: args.symbol,
      tradingDate: args.tradingDate,
      refreshVersion: args.refreshVersion,
      tier: args.tier,
      total: roundTo(args.total, args.roundDecimals),
      topContributions: contributions,
      inputsMissing: [...args.inputsMissing],
      dataFresh: args.dataFresh,
      scoredAt: args.scoredAt,
    };

    // 1) Live bus subscribers. The instrumentEventBus wildcard bridge persists
    // a row to observability_events from WHITELISTED fields only, so carry the
    // compact summary in whitelisted keys (reason/source/stage) to keep that
    // row useful.
    eventBus.emit(PREMARKET_CANDIDATE_SCORED, {
      ...payload,
      reason:
        `tier=${args.tier} total=${payload.total} ` +
        `missing=[${args.inputsMissing.join(',') || 'none'}]`,
      source: 'premarket-focus',
      stage: 'CANDIDATE_SCORED',
    });

    // 2) Full bounded decomposition, directly persisted to
    // observability_events (same path as DISCOVERY_CANDIDATE_ADMITTED via
    // discoveryCandidateLedger.ts) — this is the row operators query.
    observeSafe(() =>
      structuredLogger.info('premarket_candidate_scored', {
        category: 'PREMARKET',
        eventType: PREMARKET_CANDIDATE_SCORED,
        component: 'PremarketFocusReport',
        symbol: args.symbol,
        tradingDate: args.tradingDate,
        refreshVersion: args.refreshVersion,
        tier: args.tier,
        total: payload.total,
        topContributions: contributions,
        inputsMissing: payload.inputsMissing,
        dataFresh: args.dataFresh,
        scoredAt: args.scoredAt,
      }),
    );
  } catch (e) {
    console.error('[premarket-focus] emitPremarketCandidateScored failed (isolated)', e);
  }
}

/** Payload shape TradePlanBuilder emits (documented here so the subscriber below
 *  validates against the real contract, not an assumption). refreshVersion is
 *  the refresh-cycle version: the max plan refreshVersion for the trading
 *  date after the cycle completes (initial build = 1). The same cycle
 *  re-emitted (redelivery) carries the same version, so the subscriber's
 *  upsert on (plan_date, refresh_version) stays idempotent. */
export interface PremarketRefreshCompletedPayload {
  tradingDate: string;
  refreshVersion: number;
  refreshedAt?: string;
  planCount?: number;
  at?: string;
}

function isValidRefreshPayload(payload: unknown): payload is PremarketRefreshCompletedPayload {
  if (payload == null || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.tradingDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(p.tradingDate) &&
    Number.isInteger(p.refreshVersion) &&
    (p.refreshVersion as number) > 0
  );
}

/**
 * Emit PREMARKET_REFRESH_COMPLETED at the end of a completed trade-plan
 * refresh cycle. Called by TradePlanBuilder (initial build + every scheduled /
 * event-driven refresh). Never throws: observability must not break the
 * refresh cycle. Bounded payload: scalar identifiers, counts, timestamps only.
 */
export function emitPremarketRefreshCompleted(payload: PremarketRefreshCompletedPayload): void {
  try {
    if (!isValidRefreshPayload(payload)) {
      console.warn('[premarket-focus] refusing to emit PREMARKET_REFRESH_COMPLETED with invalid payload');
      return;
    }
    eventBus.emit(PREMARKET_REFRESH_COMPLETED, {
      tradingDate: payload.tradingDate,
      refreshVersion: payload.refreshVersion,
      refreshedAt: typeof payload.refreshedAt === 'string' ? payload.refreshedAt : null,
      planCount: typeof payload.planCount === 'number' ? payload.planCount : null,
      at: typeof payload.at === 'string' ? payload.at : new Date().toISOString(),
    });
  } catch (e) {
    console.error('[premarket-focus] emitPremarketRefreshCompleted failed (isolated)', e);
  }
}

/**
 * Subscribe to PREMARKET_REFRESH_COMPLETED and regenerate the focus report.
 * Fully defensive: malformed payloads are logged and ignored; report-build
 * failures are caught and logged; nothing ever throws into the bus.
 * Returns an unsubscribe function (used by tests; production boot wiring
 * calls this once — see the note in PremarketFocusReport.ts).
 */
export function installPremarketFocusSubscribers(): () => void {
  const handler = (payload: unknown): void => {
    try {
      if (!isValidRefreshPayload(payload)) {
        console.warn('[premarket-focus] ignoring malformed PREMARKET_REFRESH_COMPLETED payload');
        return;
      }
      // Dynamic import: PremarketFocusReport.ts dynamically imports this
      // module for emission, so a static import here would be a cycle.
      void import('./PremarketFocusReport')
        .then((m) =>
          m.buildFocusReport(payload.tradingDate, payload.refreshVersion, {
            refreshedAt: typeof payload.refreshedAt === 'string' ? payload.refreshedAt : null,
          }),
        )
        .catch((e) => {
          console.error('[premarket-focus] focus report build failed after refresh (isolated from bus)', e);
        });
    } catch (e) {
      console.error('[premarket-focus] refresh subscriber failed (isolated from bus)', e);
    }
  };
  eventBus.subscribe(PREMARKET_REFRESH_COMPLETED, handler);
  return () => eventBus.unsubscribe(PREMARKET_REFRESH_COMPLETED, handler);
}
