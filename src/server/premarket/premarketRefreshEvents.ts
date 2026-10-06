/**
 * Pre-market focus engine (2026-10-06, local-only; course-corrected 2026-10-06) — event-name
 * constants + emit helpers for the premarket plan lifecycle (workstream B).
 *
 * Lifecycle: INITIAL_BUILD (on PREMARKET_SESSION_STARTED / first PRE_MARKET tick with evidence,
 * from evidence-as-of the build tick — never mislabeled as a 04:00 plan), then MID_MORNING /
 * LATE_REFRESH / PREOPEN_VALIDATION scheduled refreshes, plus debounced EVENT_DRIVEN material
 * refreshes. Every refresh snapshots the prior version into trade_plan_revisions before mutating.
 *
 * Emitted via eventBus.emit, the same pattern SessionLifecycle.ts uses. Payloads are deliberately
 * BOUNDED: scalar identifiers, counts, and short reason strings only — never full plan objects,
 * raw component dumps, or quote payloads. These events are observability-only: none of them emits
 * a trade idea, touches ChiefTrader/RiskEngine/OMS, or implies trade eligibility.
 *
 * Deviation note (deliberate, documented): repo convention keeps event names in
 * config/eventNames.json, but workstream B's authorized file scope did not include that catalog,
 * so the names live here as the workstream's own contract. A follow-up may migrate them into
 * config/eventNames.json without changing any call site (all call sites go through the constants
 * and emit helpers below, never string literals).
 */
import { eventBus } from '../core/EventBus';

export const PREMARKET_PLAN_BUILD_STARTED = 'PREMARKET_PLAN_BUILD_STARTED';
export const PREMARKET_PLAN_BUILD_COMPLETED = 'PREMARKET_PLAN_BUILD_COMPLETED';
export const TRADE_PLAN_VERSION_CREATED = 'TRADE_PLAN_VERSION_CREATED';
export const TRADE_PLAN_UNCHANGED = 'TRADE_PLAN_UNCHANGED';
export const TRADE_PLAN_PROMOTED = 'TRADE_PLAN_PROMOTED';
export const TRADE_PLAN_DOWNGRADED = 'TRADE_PLAN_DOWNGRADED';
export const TRADE_PLAN_EXPIRED = 'TRADE_PLAN_EXPIRED';
export const PRIMARY_DATA_RESERVATION_REQUESTED = 'PRIMARY_DATA_RESERVATION_REQUESTED';
export const PRIMARY_DATA_RESERVATION_GRANTED = 'PRIMARY_DATA_RESERVATION_GRANTED';
export const PRIMARY_DATA_RESERVATION_DENIED = 'PRIMARY_DATA_RESERVATION_DENIED';
export const PRIMARY_DATA_RESERVATION_RELEASED = 'PRIMARY_DATA_RESERVATION_RELEASED';
export const PREOPEN_REVALIDATION_STARTED = 'PREOPEN_REVALIDATION_STARTED';
export const PREOPEN_REVALIDATION_COMPLETED = 'PREOPEN_REVALIDATION_COMPLETED';
export const PREMARKET_PLAN_HANDED_TO_RTH = 'PREMARKET_PLAN_HANDED_TO_RTH';

export interface PlanBuildCompletedPayload {
  tradingDate: string;
  planCount: number;
  primaryCount: number;
  evidenceAsof: string;
  at: string;
}

export interface TradePlanVersionCreatedPayload {
  planId: string;
  symbol: string;
  tradingDate: string;
  /** Refresh kind that created this version: INITIAL_BUILD | MID_MORNING_REFRESH | LATE_REFRESH |
   *  PREOPEN_VALIDATION | EVENT_DRIVEN_MATERIAL. */
  refreshKind: string;
  refreshVersion: number;
  refreshedAt: string;
  reasonForRefresh: string;
  /** Names of the plan fields that materially changed (bounded - never the full values). */
  changedFields: string[];
  tierChanged: { from: string; to: string } | null;
  at: string;
}

export interface TradePlanUnchangedPayload {
  tradingDate: string;
  /** Which refresh ran and found nothing material. */
  kind: string;
  planCount: number;
  at: string;
}

export interface TradePlanTierChangedPayload {
  planId: string;
  symbol: string;
  tradingDate: string;
  refreshVersion: number;
  fromTier: string;
  toTier: string;
  at: string;
}

export interface TradePlanExpiredPayload {
  planId: string;
  symbol: string;
  tradingDate: string;
  reason: string;
  refreshVersion: number;
  at: string;
}

export interface DataReservationPayload {
  reservationId: string | null;
  symbol: string;
  planId: string | null;
  tier: string;
  reason: string;
  expiresAt: string | null;
  /** Present on DENIED only: POOL_EXHAUSTED | DUPLICATE_ACTIVE_RESERVATION | INVALID_SYMBOL |
   *  INVALID_TTL | PAST_HANDOVER. Present on RELEASED only: the release reason. */
  detail: string | null;
  at: string;
}

export interface PreopenRevalidationCompletedPayload {
  tradingDate: string;
  planCount: number;
  refreshedCount: number;
  expiredCount: number;
  downgradedCount: number;
  at: string;
}

export interface PremarketPlanHandedToRthPayload {
  tradingDate: string;
  releasedReservations: number;
  at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function emitPremarketPlanBuildStarted(tradingDate: string, at: string = nowIso()): void {
  eventBus.emit(PREMARKET_PLAN_BUILD_STARTED, { tradingDate, at });
}

export function emitPremarketPlanBuildCompleted(payload: PlanBuildCompletedPayload): void {
  eventBus.emit(PREMARKET_PLAN_BUILD_COMPLETED, payload);
}

export function emitTradePlanVersionCreated(payload: TradePlanVersionCreatedPayload): void {
  eventBus.emit(TRADE_PLAN_VERSION_CREATED, payload);
}

export function emitTradePlanUnchanged(payload: TradePlanUnchangedPayload): void {
  eventBus.emit(TRADE_PLAN_UNCHANGED, payload);
}

export function emitTradePlanPromoted(payload: TradePlanTierChangedPayload): void {
  eventBus.emit(TRADE_PLAN_PROMOTED, payload);
}

export function emitTradePlanDowngraded(payload: TradePlanTierChangedPayload): void {
  eventBus.emit(TRADE_PLAN_DOWNGRADED, payload);
}

export function emitTradePlanExpired(payload: TradePlanExpiredPayload): void {
  eventBus.emit(TRADE_PLAN_EXPIRED, payload);
}

export function emitDataReservationRequested(payload: DataReservationPayload): void {
  eventBus.emit(PRIMARY_DATA_RESERVATION_REQUESTED, payload);
}

export function emitDataReservationGranted(payload: DataReservationPayload): void {
  eventBus.emit(PRIMARY_DATA_RESERVATION_GRANTED, payload);
}

export function emitDataReservationDenied(payload: DataReservationPayload): void {
  eventBus.emit(PRIMARY_DATA_RESERVATION_DENIED, payload);
}

export function emitDataReservationReleased(payload: DataReservationPayload): void {
  eventBus.emit(PRIMARY_DATA_RESERVATION_RELEASED, payload);
}

export function emitPreopenRevalidationStarted(tradingDate: string, at: string = nowIso()): void {
  eventBus.emit(PREOPEN_REVALIDATION_STARTED, { tradingDate, at });
}

export function emitPreopenRevalidationCompleted(payload: PreopenRevalidationCompletedPayload): void {
  eventBus.emit(PREOPEN_REVALIDATION_COMPLETED, payload);
}

export function emitPremarketPlanHandedToRth(payload: PremarketPlanHandedToRthPayload): void {
  eventBus.emit(PREMARKET_PLAN_HANDED_TO_RTH, payload);
}
