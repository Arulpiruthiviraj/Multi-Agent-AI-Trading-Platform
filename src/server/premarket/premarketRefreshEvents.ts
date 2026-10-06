/**
 * Pre-market focus engine (2026-10-06, local-only) — event-name constants + emit helpers for the
 * late pre-market refresh (workstream B) and the bounded data-reservation manager.
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

export const PREMARKET_REFRESH_STARTED = 'PREMARKET_REFRESH_STARTED';
export const PREMARKET_REFRESH_COMPLETED = 'PREMARKET_REFRESH_COMPLETED';
export const TRADEPLAN_REFRESHED = 'TRADEPLAN_REFRESHED';
export const TRADEPLAN_EXPIRED = 'TRADEPLAN_EXPIRED';
export const PRIMARY_DATA_RESERVATION_REQUESTED = 'PRIMARY_DATA_RESERVATION_REQUESTED';
export const PRIMARY_DATA_RESERVATION_GRANTED = 'PRIMARY_DATA_RESERVATION_GRANTED';
export const PRIMARY_DATA_RESERVATION_DENIED = 'PRIMARY_DATA_RESERVATION_DENIED';
export const PRIMARY_DATA_RESERVATION_RELEASED = 'PRIMARY_DATA_RESERVATION_RELEASED';

export interface PremarketRefreshCompletedPayload {
  tradingDate: string;
  /** Highest refreshVersion across the date's plans after this run (1 when nothing changed). */
  refreshVersion: number;
  refreshedAt: string;
  planCount: number;
  refreshedCount: number;
  unchangedCount: number;
  expiredCount: number;
  skippedCount: number;
  at: string;
}

export interface TradePlanRefreshedPayload {
  planId: string;
  symbol: string;
  tradingDate: string;
  refreshVersion: number;
  refreshedAt: string;
  reasonForRefresh: string;
  /** Names of the plan fields that materially changed (bounded - never the full values). */
  changedFields: string[];
  tierChanged: { from: string; to: string } | null;
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

function nowIso(): string {
  return new Date().toISOString();
}

export function emitPremarketRefreshStarted(tradingDate: string, at: string = nowIso()): void {
  eventBus.emit(PREMARKET_REFRESH_STARTED, { tradingDate, at });
}

export function emitPremarketRefreshCompleted(payload: PremarketRefreshCompletedPayload): void {
  eventBus.emit(PREMARKET_REFRESH_COMPLETED, payload);
}

export function emitTradePlanRefreshed(payload: TradePlanRefreshedPayload): void {
  eventBus.emit(TRADEPLAN_REFRESHED, payload);
}

export function emitTradePlanExpired(payload: TradePlanExpiredPayload): void {
  eventBus.emit(TRADEPLAN_EXPIRED, payload);
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
