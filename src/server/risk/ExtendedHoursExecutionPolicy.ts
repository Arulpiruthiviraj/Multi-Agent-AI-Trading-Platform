/**
 * Session-Aware Trading Architecture Phase 5 (2026-09-05, ARGUS_PREMARKET_GAP_ANALYSIS.md §7).
 * Pure checks used by RiskEngine's gate 25 (extended_hours_execution_policy) and by OMS's
 * order-construction resolution. Same shape/discipline as OvertradingGuards.ts.
 *
 * Governance: this module does not gate, weaken, or replace any of the existing 24 RiskEngine
 * gates. It ADDS one new check that only ever evaluates (and can only ever fail) when the order
 * is genuinely an extended-hours attempt - for a REGULAR-session order, or when
 * isExtendedHoursExecutionEnabled() is off, every function here is a documented no-op/pass.
 *
 * Honesty note: this codebase has no L2 feed and, until this pass, no ask price at all (see
 * MarketDataWorker.ts's getLatestSpreadBps doc comment) - min liquidity / average daily volume was
 * originally deliberately NOT implemented as a check here, matching ComposableRanking.ts's own
 * NOT_IMPLEMENTED_COMPONENTS discipline, rather than fabricating a threshold against data this gate
 * did not cleanly have access to. That gap is now closed (2026-09-05,
 * docs/audits/ARGUS_PREMARKET_TRADING_IMPLEMENTATION.md): ExtendedHoursLiquidityCache.ts reuses the
 * SAME real fetchAvgDailyVolumeShares() the broad-universe liquidity screen already calls - never a
 * second, duplicate ADV calculation - cached (not fetched inline per order, since a gate evaluation
 * must stay synchronous) and read here as a plain input, same pattern as spreadBps/quoteAgeMs.
 */
import type { MarketSession } from '../replay/marketSession';
import { tradingSafety } from '../config/tradingSafety';
import type { BrokerCapabilities } from '../../brokers/BrokerAdapter';

export interface ExtendedHoursGateResult {
  gate: 'extended_hours_execution_policy';
  passed: boolean;
  detail: Record<string, unknown>;
  reason: string;
}

/** True only for a session where extended-hours order attempts are even conceptually possible. */
export function isExtendedHoursSession(session: MarketSession): boolean {
  return session === 'PRE_MARKET' || session === 'AFTER_HOURS';
}

/**
 * Gate 25. Auto-passes (skipped: true) whenever the order is not a genuine extended-hours attempt
 * - a REGULAR-session order, or the master flag being off, changes NOTHING about this gate's
 * result versus before this module existed.
 */
export function evaluateExtendedHoursExecutionPolicy(input: {
  session: MarketSession;
  extendedHoursExecutionEnabled: boolean;
  brokerCapabilities: BrokerCapabilities | null;
  quoteAgeMs: number | null;
  spreadBps: number | null;
  notionalDollars: number | null;
  /** Real cached average daily volume (shares) from ExtendedHoursLiquidityCache.ts - null means no
   *  data has been fetched for this symbol yet (fails closed, never assumed sufficient). */
  avgDailyVolumeShares: number | null;
}): ExtendedHoursGateResult {
  const base = { gate: 'extended_hours_execution_policy' as const };

  if (!isExtendedHoursSession(input.session)) {
    return { ...base, passed: true, detail: { skipped: true, reason: 'not an extended-hours session' }, reason: 'Not applicable - regular session.' };
  }
  if (!input.extendedHoursExecutionEnabled) {
    return { ...base, passed: true, detail: { skipped: true, reason: 'extended-hours execution disabled' }, reason: 'Not applicable - extended-hours execution is disabled.' };
  }

  if (!input.brokerCapabilities?.extendedHoursOrders) {
    return {
      ...base, passed: false,
      detail: { skipped: false, brokerExtendedHoursCapable: false },
      reason: 'EXTENDED_HOURS_BROKER_UNSUPPORTED: the active broker adapter does not implement extended-hours order construction.',
    };
  }

  if (input.quoteAgeMs == null || input.quoteAgeMs > tradingSafety.extendedHoursMaxQuoteAgeMs) {
    return {
      ...base, passed: false,
      detail: { skipped: false, quoteAgeMs: input.quoteAgeMs, maxQuoteAgeMs: tradingSafety.extendedHoursMaxQuoteAgeMs },
      reason: `EXTENDED_HOURS_STALE_QUOTE: no fresh quote/trade within ${tradingSafety.extendedHoursMaxQuoteAgeMs}ms (age=${input.quoteAgeMs ?? 'never'}). Fresh-quote required outside RTH.`,
    };
  }

  if (input.spreadBps != null && input.spreadBps > tradingSafety.extendedHoursMaxSpreadBps) {
    return {
      ...base, passed: false,
      detail: { skipped: false, spreadBps: input.spreadBps, maxSpreadBps: tradingSafety.extendedHoursMaxSpreadBps },
      reason: `EXTENDED_HOURS_SPREAD_TOO_WIDE: real bid/ask spread ${input.spreadBps.toFixed(1)}bps exceeds ${tradingSafety.extendedHoursMaxSpreadBps}bps cap.`,
    };
  }
  // A real ask has never been observed for this symbol - fail closed rather than assume a tight
  // spread the data cannot actually support (same "never fabricate" discipline as every other
  // gate in this codebase - see gate 15 price_validity's own NON_FINITE_PRICE etc. reason codes).
  if (input.spreadBps == null) {
    return {
      ...base, passed: false,
      detail: { skipped: false, spreadBps: null },
      reason: 'EXTENDED_HOURS_NO_SPREAD_DATA: no real bid/ask spread available for this symbol - cannot honestly evaluate spread risk outside RTH.',
    };
  }

  // Real ADV check (see this file's own header for why this was previously NOT_IMPLEMENTED and how
  // it's now sourced). Fails closed on missing data - a symbol ExtendedHoursLiquidityCache.ts has
  // never successfully fetched is not assumed liquid.
  if (input.avgDailyVolumeShares == null) {
    return {
      ...base, passed: false,
      detail: { skipped: false, avgDailyVolumeShares: null },
      reason: 'EXTENDED_HOURS_NO_LIQUIDITY_DATA: no real average-daily-volume data cached for this symbol yet - cannot honestly evaluate liquidity risk outside RTH.',
    };
  }
  if (input.avgDailyVolumeShares < tradingSafety.extendedHoursMinAvgDailyVolumeShares) {
    return {
      ...base, passed: false,
      detail: { skipped: false, avgDailyVolumeShares: input.avgDailyVolumeShares, minAvgDailyVolumeShares: tradingSafety.extendedHoursMinAvgDailyVolumeShares },
      reason: `EXTENDED_HOURS_INSUFFICIENT_LIQUIDITY: real average daily volume ${input.avgDailyVolumeShares.toLocaleString()} shares is below the ${tradingSafety.extendedHoursMinAvgDailyVolumeShares.toLocaleString()}-share extended-hours floor.`,
    };
  }

  if (input.notionalDollars != null && input.notionalDollars > tradingSafety.extendedHoursMaxNotionalDollars) {
    return {
      ...base, passed: false,
      detail: { skipped: false, notionalDollars: input.notionalDollars, maxNotionalDollars: tradingSafety.extendedHoursMaxNotionalDollars },
      reason: `EXTENDED_HOURS_NOTIONAL_CAP: requested notional $${input.notionalDollars.toFixed(2)} exceeds the extended-hours cap of $${tradingSafety.extendedHoursMaxNotionalDollars} (deliberately stricter than the regular-session order_notional_cap gate).`,
    };
  }

  return {
    ...base, passed: true,
    detail: { skipped: false, quoteAgeMs: input.quoteAgeMs, spreadBps: input.spreadBps, avgDailyVolumeShares: input.avgDailyVolumeShares, notionalDollars: input.notionalDollars },
    reason: 'Extended-hours execution policy satisfied.',
  };
}

/**
 * OMS-side order-construction resolution. Returns the existing plain MARKET shape unchanged for
 * every case except a genuine, enabled, priced extended-hours attempt - so a caller that never
 * enables the flag (the default) gets byte-for-byte the same order it always has.
 */
export type ResolvedOrderConstruction =
  | { type: 'MARKET' }
  | { type: 'LIMIT'; price: number; extendedHours: true };

export function resolveOrderConstruction(
  session: MarketSession,
  intendedPrice: number | null | undefined,
  extendedHoursExecutionEnabled: boolean,
): ResolvedOrderConstruction {
  if (!extendedHoursExecutionEnabled) return { type: 'MARKET' };
  if (!isExtendedHoursSession(session)) return { type: 'MARKET' };
  if (typeof intendedPrice !== 'number' || !Number.isFinite(intendedPrice) || intendedPrice <= 0) {
    // No fabricated limit price - fall back to MARKET's existing behavior rather than guess one.
    // (RiskEngine's own gate 25 / gate 15 price_validity are expected to have already rejected an
    // order with no valid price before OMS ever reaches this - this is defense in depth, not the
    // primary safeguard.)
    return { type: 'MARKET' };
  }
  return { type: 'LIMIT', price: intendedPrice, extendedHours: true };
}
