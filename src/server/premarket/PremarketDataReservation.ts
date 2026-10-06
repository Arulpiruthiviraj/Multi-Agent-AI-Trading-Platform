/**
 * Pre-market focus engine (2026-10-06, local-only; course-corrected 2026-10-06) — bounded pre-open
 * data reservation manager (workstream B).
 *
 * A PRIMARY-tier TradePlan may hold a bounded, expiring reservation for subscription capacity so
 * it has a real chance at fresh data by the open. Reservations are NEVER permanent: a reservation
 * ends at expiresAt, on plan expiry / tier drop / invalidation, or at the market-open handover —
 * whichever comes first.
 *
 * Subscription priority ordering (2026-10-06):
 *   ACTIVE_POSITION > PENDING_ORDER > PRIMARY_PLAN > FAST_ACTIONABLE > NORMAL_DISCOVERY
 * persisted as the numeric `priority` column and exported as RESERVATION_PRIORITY below.
 *
 * Deviation from MarketDataWorker's existing classes (documented, not hidden): MarketDataWorker's
 * admission control speaks RescueRequestClass (ROUTINE_RECOVERY | EXPLORATION | MARKET_MOVER |
 * NEWS_CATALYST) plus an unconditional protected set (SPY/QQQ/GLD) — it has no position/order
 * concepts and no 5-level plan/actionable/discovery hierarchy. This manager does NOT change that
 * admission logic (untouched). Instead: (a) the 5-level ordering is the reservation ledger's own
 * priority, governing any future preemption and operator triage; (b) a GRANTED PRIMARY_PLAN
 * reservation requests temporary subscription priority through the EXISTING
 * requestTemporaryDataRescue() with class EXPLORATION — the rescue budget already reserves slots
 * for EXPLORATION/MARKET_MOVER-class requests (rescueReservedSlotsForPriorityClasses), so a
 * PRIMARY plan's rescue competes in the priority lane, not the routine-recovery lane. Tier
 * mapping for the persisted column: PRIMARY -> PRIMARY_PLAN, BACKUP -> FAST_ACTIONABLE,
 * WATCHLIST -> NORMAL_DISCOVERY (only PRIMARY is requested by the refresh today; the others are
 * defined so the column stays meaningful if policy ever widens).
 *
 * Why cap + early expiry (not priority preemption) protects the 09:20-09:30 emerging movers:
 * the pool is a strict subset of streaming capacity (premarketReservedSlots=4 of
 * maxActiveSubscriptions=12 — at least one slot always stays un-reservable, enforced at config
 * load), and every reservation dies no later than the 09:25 ET handover, which is BEFORE the
 * 09:25-09:35 momentum rotation window (momentumScanWindowStartEt). By the time emerging movers
 * need slots, pre-open reservations have already released — the two mechanisms never overlap.
 * The session handoff (PREMARKET_PLAN_HANDED_TO_RTH) additionally releases every ACTIVE row.
 * Intraday Fast Lane / discovery subscriptions are never touched here — only this ledger's rows.
 *
 * Diagnostic + capacity-management only: granting a reservation is not trade eligibility, never
 * emits a trade idea, and never bypasses ChiefTrader/RiskEngine/OMS.
 *
 * Persistence: premarket_data_reservations (migration 0090). db is imported ONLY from
 * src/server/db/index.ts. Callers that want honest capacity accounting call sweepExpired() before
 * requesting (the refresh orchestration does); request() itself counts ACTIVE rows as-is.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { premarketDataReservations } from '../db/schema';
import { and, count, eq } from 'drizzle-orm';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { getTradingDateStr, tradingWallTimeToIso } from '../core/TradingCalendar';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import {
  emitDataReservationDenied,
  emitDataReservationGranted,
  emitDataReservationReleased,
  emitDataReservationRequested,
} from './premarketRefreshEvents';

export type ReservationTier = 'PRIMARY' | 'BACKUP' | 'WATCHLIST';
export type ReservationStatus = 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'DENIED';

export type ReservationDeniedReason =
  | 'POOL_EXHAUSTED'
  | 'DUPLICATE_ACTIVE_RESERVATION'
  | 'INVALID_SYMBOL'
  | 'INVALID_TTL'
  | 'PAST_HANDOVER'
  | 'HANDOVER_UNRESOLVABLE';

export type ReservationRow = typeof premarketDataReservations.$inferSelect;

/**
 * Subscription priority ordering, highest first. See the module header for the deviation note
 * vs MarketDataWorker's RescueRequestClass.
 */
export const RESERVATION_PRIORITY = {
  ACTIVE_POSITION: 50,
  PENDING_ORDER: 40,
  PRIMARY_PLAN: 30,
  FAST_ACTIONABLE: 20,
  NORMAL_DISCOVERY: 10,
} as const;

export type ReservationPriorityClass = keyof typeof RESERVATION_PRIORITY;

/** Minimal structural port over MarketDataWorker.requestTemporaryDataRescue() — the least
 *  invasive existing API for temporary subscription priority. Injected in tests; production uses
 *  the real singleton via lazy import (no import-cycle risk, no module-load cost). */
export interface DataRescuePort {
  requestTemporaryDataRescue(
    symbol: string,
    reason: string,
    opts?: { requestClass?: string; traceId?: string },
  ): { granted: boolean; symbol: string; alreadySubscribed: boolean; evictedSymbol: string | null; deniedReason?: string };
}

async function defaultRescuePort(): Promise<DataRescuePort> {
  const { marketDataWorker } = await import('../services/MarketDataWorker');
  return marketDataWorker;
}

export interface ReservationRequestOptions {
  now?: Date;
  /** Test-only injection; production callers omit it and get the real MarketDataWorker path. */
  rescuePort?: DataRescuePort;
}

export interface ReservationRequestResult {
  outcome: 'GRANTED' | 'DENIED';
  deniedReason?: ReservationDeniedReason;
  reservation?: ReservationRow;
  /** Present on GRANTED for PRIMARY: whether the follow-on rescue priority request succeeded.
   *  A rescue denial never fails the reservation — it is best-effort subscription priority. */
  rescueGranted?: boolean;
  rescueDeniedReason?: string;
}

// ── Perf instrumentation: DB query counting for the refresh perf sample ──
// The refresh runner resets both counters before a run and sums them after; the sample is the
// honest "DB queries issued by this refresh". These counters are module-local and never affect
// query semantics.
let managerDbQueries = 0;
function mcounted<T>(p: Promise<T>): Promise<T> {
  managerDbQueries++;
  return p;
}
/** Test/perf-only: reset the manager's DB query counter. */
export function resetManagerDbQueryCount(): void {
  managerDbQueries = 0;
}
/** Test/perf-only: read the manager's DB query counter. */
export function getManagerDbQueryCount(): number {
  return managerDbQueries;
}

/**
 * Effective reservation cap: the configured pool size, hard-bounded by maxActiveSubscriptions so
 * a config typo can never reserve more than the entire streaming pool. Config load already
 * enforces premarketReservedSlots < maxActiveSubscriptions; the min() here is defense in depth.
 */
export function getReservationCap(): number {
  const cap = Math.min(continuousIntelligence.premarketReservedSlots, continuousIntelligence.maxActiveSubscriptions);
  return Math.max(0, Math.floor(cap));
}

export async function countActiveReservations(): Promise<number> {
  const rows = await mcounted(
    db.select({ n: count() }).from(premarketDataReservations).where(eq(premarketDataReservations.status, 'ACTIVE')),
  );
  return rows[0]?.n ?? 0;
}

export async function getActiveReservations(): Promise<ReservationRow[]> {
  return mcounted(db.select().from(premarketDataReservations).where(eq(premarketDataReservations.status, 'ACTIVE')));
}

/** Release-condition contract, persisted verbatim on every row so the expiry semantics are
 *  auditable from the database alone. */
export const RESERVATION_RELEASE_CONDITION =
  'EXPIRES_AT_OR_PLAN_EXPIRY_OR_TIER_DROP_OR_INVALIDATION_OR_MARKET_OPEN_HANDOVER';

/** Persisted numeric priority per reservation tier (see RESERVATION_PRIORITY and the header). */
function tierPriority(tier: ReservationTier): number {
  return tier === 'PRIMARY'
    ? RESERVATION_PRIORITY.PRIMARY_PLAN
    : tier === 'BACKUP'
      ? RESERVATION_PRIORITY.FAST_ACTIONABLE
      : RESERVATION_PRIORITY.NORMAL_DISCOVERY;
}

function handoverInstant(tradingDate: string): number {
  return Date.parse(tradingWallTimeToIso(tradingDate, continuousIntelligence.premarketReservationHandoverEt));
}

async function persistDenied(
  symbol: string,
  planId: string | null,
  tier: ReservationTier,
  reason: string,
  deniedReason: ReservationDeniedReason,
  nowIso: string,
): Promise<ReservationRow> {
  const row = {
    id: randomUUID(),
    symbol,
    planId,
    tier,
    requestedAt: nowIso,
    expiresAt: nowIso,
    reason,
    priority: tierPriority(tier),
    releaseCondition: RESERVATION_RELEASE_CONDITION,
    status: 'DENIED' as ReservationStatus,
    releasedAt: nowIso,
    releaseReason: deniedReason,
    createdAt: nowIso,
  };
  await mcounted(db.insert(premarketDataReservations).values(row));
  return row;
}

/**
 * Request a bounded pre-open data reservation.
 *
 * Denial reasons are explicit and persisted (status DENIED) so every denial is auditable:
 * INVALID_SYMBOL / INVALID_TTL fail input validation; DUPLICATE_ACTIVE_RESERVATION means the
 * symbol is already covered; POOL_EXHAUSTED means the bounded pool is full; PAST_HANDOVER means
 * the request arrived after the market-open handover (a reservation would be born expired);
 * HANDOVER_UNRESOLVABLE means the handover instant could not be computed (fail closed rather
 * than mint an unbounded reservation).
 */
export async function requestDataReservation(
  symbol: string,
  planId: string | null,
  tier: ReservationTier,
  reason: string,
  ttlMinutes: number,
  opts: ReservationRequestOptions = {},
): Promise<ReservationRequestResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const tradingDate = getTradingDateStr(now);
  const normalizedSymbol = symbol?.trim().toUpperCase() ?? '';

  const deny = async (deniedReason: ReservationDeniedReason): Promise<ReservationRequestResult> => {
    await persistDenied(normalizedSymbol || symbol, planId, tier, reason, deniedReason, nowIso);
    emitDataReservationDenied({
      reservationId: null,
      symbol: normalizedSymbol || symbol,
      planId,
      tier,
      reason,
      expiresAt: null,
      detail: deniedReason,
      at: nowIso,
    });
    return { outcome: 'DENIED', deniedReason };
  };

  emitDataReservationRequested({
    reservationId: null,
    symbol: normalizedSymbol || symbol,
    planId,
    tier,
    reason,
    expiresAt: null,
    detail: null,
    at: nowIso,
  });

  if (!normalizedSymbol || !looksLikeListedTicker(normalizedSymbol)) {
    return deny('INVALID_SYMBOL');
  }
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    return deny('INVALID_TTL');
  }

  let handoverMs: number;
  try {
    handoverMs = handoverInstant(tradingDate);
  } catch {
    return deny('HANDOVER_UNRESOLVABLE');
  }
  const expiresAtMs = Math.min(now.getTime() + ttlMinutes * 60_000, handoverMs);
  if (expiresAtMs <= now.getTime()) {
    return deny('PAST_HANDOVER');
  }

  const duplicate = await mcounted(
    db.select({ id: premarketDataReservations.id })
      .from(premarketDataReservations)
      .where(
        and(
          eq(premarketDataReservations.symbol, normalizedSymbol),
          eq(premarketDataReservations.status, 'ACTIVE'),
        ),
      )
      .limit(1),
  );
  if (duplicate.length > 0) {
    return deny('DUPLICATE_ACTIVE_RESERVATION');
  }

  const active = await countActiveReservations();
  if (active >= getReservationCap()) {
    return deny('POOL_EXHAUSTED');
  }

  const row = {
    id: randomUUID(),
    symbol: normalizedSymbol,
    planId,
    tier,
    requestedAt: nowIso,
    expiresAt: new Date(expiresAtMs).toISOString(),
    reason,
    priority: tierPriority(tier),
    releaseCondition: RESERVATION_RELEASE_CONDITION,
    status: 'ACTIVE' as ReservationStatus,
    releasedAt: null,
    releaseReason: null,
    createdAt: nowIso,
  };
  await mcounted(db.insert(premarketDataReservations).values(row));
  const reservation = (await mcounted(
    db.select().from(premarketDataReservations).where(eq(premarketDataReservations.id, row.id)).limit(1),
  ))[0]!;

  emitDataReservationGranted({
    reservationId: reservation.id,
    symbol: reservation.symbol,
    planId,
    tier,
    reason,
    expiresAt: reservation.expiresAt,
    detail: null,
    at: nowIso,
  });

  let rescueGranted: boolean | undefined;
  let rescueDeniedReason: string | undefined;
  if (tier === 'PRIMARY') {
    try {
      const port = opts.rescuePort ?? (await defaultRescuePort());
      const rescue = port.requestTemporaryDataRescue(
        normalizedSymbol,
        `premarket_data_reservation:${reservation.id}`,
        { requestClass: 'EXPLORATION' },
      );
      rescueGranted = rescue.granted;
      rescueDeniedReason = rescue.deniedReason;
    } catch (e) {
      // The reservation stands; the rescue is best-effort subscription priority, and a rescue-
      // path failure must never fail the reservation or throw into the refresh orchestration.
      rescueGranted = false;
      rescueDeniedReason = e instanceof Error ? e.message : String(e);
    }
  }

  return { outcome: 'GRANTED', reservation, rescueGranted, rescueDeniedReason };
}

/**
 * Release one reservation. Returns false (no-op, no event) when the id is unknown or not ACTIVE —
 * releasing twice is idempotent, never an error.
 */
export async function releaseDataReservation(
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<boolean> {
  const nowIso = now.toISOString();
  const rows = await mcounted(
    db.select().from(premarketDataReservations).where(eq(premarketDataReservations.id, id)).limit(1),
  );
  const row = rows[0];
  if (!row || row.status !== 'ACTIVE') return false;
  await mcounted(
    db.update(premarketDataReservations)
      .set({ status: 'RELEASED', releasedAt: nowIso, releaseReason: reason })
      .where(eq(premarketDataReservations.id, id)),
  );
  emitDataReservationReleased({
    reservationId: row.id,
    symbol: row.symbol,
    planId: row.planId,
    tier: row.tier,
    reason: row.reason,
    expiresAt: row.expiresAt,
    detail: reason,
    at: nowIso,
  });
  return true;
}

/**
 * Release every ACTIVE reservation for a plan — the plan-expiry / tier-drop / invalidation leg of
 * the release contract. Called by the refresh orchestration; returns the number released.
 */
export async function releaseReservationsForPlan(
  planId: string,
  reason: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await mcounted(
    db.select()
      .from(premarketDataReservations)
      .where(
        and(eq(premarketDataReservations.planId, planId), eq(premarketDataReservations.status, 'ACTIVE')),
      ),
  );
  let released = 0;
  for (const row of rows) {
    if (await releaseDataReservation(row.id, reason, now)) released++;
  }
  return released;
}

/**
 * Release every ACTIVE reservation in the ledger — the market-open handover leg of the release
 * contract (PREMARKET_PLAN_HANDED_TO_RTH). Only this ledger's rows are touched: intraday Fast
 * Lane / discovery subscriptions and MarketDataWorker's own rescue grants are never cancelled
 * here (rescue grants lapse via their own bounded TTL). Returns the number released.
 */
export async function releaseAllActiveReservations(
  reason: string,
  now: Date = new Date(),
): Promise<number> {
  const active = await getActiveReservations();
  let released = 0;
  for (const row of active) {
    if (await releaseDataReservation(row.id, reason, now)) released++;
  }
  return released;
}

/**
 * Mark every ACTIVE reservation at or past expiresAt as EXPIRED (emits RELEASED per row with
 * detail 'EXPIRED'). Returns the number expired. This is the TTL/handover leg of the release
 * contract — the mechanism that frees capacity for the 09:20-09:30 movers rotation.
 */
export async function sweepExpiredReservations(now: Date = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const active = await getActiveReservations();
  let expired = 0;
  for (const row of active) {
    if (row.expiresAt <= nowIso) {
      await mcounted(
        db.update(premarketDataReservations)
          .set({ status: 'EXPIRED', releasedAt: nowIso, releaseReason: 'EXPIRED' })
          .where(eq(premarketDataReservations.id, row.id)),
      );
      emitDataReservationReleased({
        reservationId: row.id,
        symbol: row.symbol,
        planId: row.planId,
        tier: row.tier,
        reason: row.reason,
        expiresAt: row.expiresAt,
        detail: 'EXPIRED',
        at: nowIso,
      });
      expired++;
    }
  }
  return expired;
}

/** Operator/diagnostic view: cap, active count, and remaining headroom in one call. */
export async function getReservationPoolStatus(): Promise<{
  cap: number;
  active: number;
  available: number;
  maxActiveSubscriptions: number;
}> {
  const cap = getReservationCap();
  const active = await countActiveReservations();
  return {
    cap,
    active,
    available: Math.max(0, cap - active),
    maxActiveSubscriptions: continuousIntelligence.maxActiveSubscriptions,
  };
}
