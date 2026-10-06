/**
 * Pre-market focus engine (2026-10-06, local-only) — bounded pre-open data reservation manager
 * (workstream B).
 *
 * A PRIMARY-tier TradePlan may hold a bounded, expiring reservation for subscription capacity so
 * it has a real chance at fresh data by the open. Reservations are NEVER permanent: a reservation
 * ends at expiresAt, on plan expiry / tier drop / invalidation, or at the market-open handover —
 * whichever comes first.
 *
 * Why cap + early expiry (not priority preemption) protects the 09:20-09:30 emerging movers:
 * the pool is a strict subset of streaming capacity (premarketReservedSlots=4 of
 * maxActiveSubscriptions=12 — at least one slot always stays un-reservable, enforced at config
 * load), and every reservation dies no later than the 09:25 ET handover, which is BEFORE the
 * 09:25-09:35 momentum rotation window (momentumScanWindowStartEt). By the time emerging movers
 * need slots, pre-open reservations have already released — the two mechanisms never overlap.
 *
 * Diagnostic + capacity-management only: granting a reservation is not trade eligibility, never
 * emits a trade idea, and never bypasses ChiefTrader/RiskEngine/OMS. On GRANTED for PRIMARY the
 * manager requests temporary subscription priority through MarketDataWorker's EXISTING public
 * requestTemporaryDataRescue() (the same bounded mechanism emitTradePlanIdea already uses) —
 * a rescue grants a subscription chance, not an instant tick, and its denial never fails the
 * reservation itself.
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
  const rows = await db
    .select({ n: count() })
    .from(premarketDataReservations)
    .where(eq(premarketDataReservations.status, 'ACTIVE'));
  return rows[0]?.n ?? 0;
}

export async function getActiveReservations(): Promise<ReservationRow[]> {
  return db.select().from(premarketDataReservations).where(eq(premarketDataReservations.status, 'ACTIVE'));
}

/** Release-condition contract, persisted verbatim on every row so the expiry semantics are
 *  auditable from the database alone. */
export const RESERVATION_RELEASE_CONDITION =
  'EXPIRES_AT_OR_PLAN_EXPIRY_OR_TIER_DROP_OR_INVALIDATION_OR_MARKET_OPEN_HANDOVER';

/** Priority persisted on the row: PRIMARY outranks BACKUP outranks WATCHLIST for any future
 *  operator triage. Capacity admission itself is first-come-first-served within the cap. */
function tierPriority(tier: ReservationTier): number {
  return tier === 'PRIMARY' ? 2 : tier === 'BACKUP' ? 1 : 0;
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
  await db.insert(premarketDataReservations).values(row);
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

  const duplicate = await db
    .select({ id: premarketDataReservations.id })
    .from(premarketDataReservations)
    .where(
      and(
        eq(premarketDataReservations.symbol, normalizedSymbol),
        eq(premarketDataReservations.status, 'ACTIVE'),
      ),
    )
    .limit(1);
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
  await db.insert(premarketDataReservations).values(row);
  const reservation = (await db
    .select()
    .from(premarketDataReservations)
    .where(eq(premarketDataReservations.id, row.id))
    .limit(1))[0]!;

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
  const rows = await db
    .select()
    .from(premarketDataReservations)
    .where(eq(premarketDataReservations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== 'ACTIVE') return false;
  await db
    .update(premarketDataReservations)
    .set({ status: 'RELEASED', releasedAt: nowIso, releaseReason: reason })
    .where(eq(premarketDataReservations.id, id));
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
  const rows = await db
    .select()
    .from(premarketDataReservations)
    .where(
      and(eq(premarketDataReservations.planId, planId), eq(premarketDataReservations.status, 'ACTIVE')),
    );
  let released = 0;
  for (const row of rows) {
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
      await db
        .update(premarketDataReservations)
        .set({ status: 'EXPIRED', releasedAt: nowIso, releaseReason: 'EXPIRED' })
        .where(eq(premarketDataReservations.id, row.id));
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
