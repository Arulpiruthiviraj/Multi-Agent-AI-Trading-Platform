import { describe, expect, it } from 'vitest';
import { reconcileStatus, type IbkrSubscriptionStateShape } from './marketDataDiagnosticsReport';

/**
 * 2026-09-21 Phase 2 (IBKR market-data lifecycle hardening). Targeted unit coverage for
 * reconcileStatus() - the real fix for the post-fix adversarial audit's own diagnostics finding:
 * MarketDataWorker.getMarketDataError() is only ever populated by a REAL IBKR error event, so a
 * symbol stuck in RETRY_WAIT via the (now-removed) confirmation-timeout path previously showed as
 * SUBSCRIPTION_ACTIVE in the one diagnostic tool an operator would actually check. This is a pure
 * function of already-known inputs - no broker/DB/singleton needed to test it directly.
 */
const record = (overrides: Partial<IbkrSubscriptionStateShape>): IbkrSubscriptionStateShape => ({
  state: 'REQUESTING', tickerId: 1, generation: 0, lastRequestAt: Date.now(),
  lastAcknowledgedAt: null, acknowledgementKind: null, marketDataType: null,
  retryCount: 0, nextRetryAt: null, lastInternalFailureKind: null,
  ...overrides,
});

describe('reconcileStatus (unified subscription-lifecycle diagnostic view)', () => {
  it('never shows SUBSCRIPTION_ACTIVE-style lineState when the real IBKR lifecycle says RETRY_WAIT - the exact gap the adversarial audit found', () => {
    const lifecycle = record({ state: 'RETRY_WAIT', retryCount: 2, nextRetryAt: Date.now() + 60_000 });
    // Even if the older, coarser lineState classifier had no error on record (its own real gap -
    // it only reads MarketDataWorker.getMarketDataError, never the lifecycle record), the
    // reconciled status must reflect the real, more authoritative lifecycle state.
    expect(reconcileStatus('SUBSCRIPTION_ACTIVE', lifecycle)).toBe('RETRY_WAIT');
  });

  it('REQUESTING with no internal failure flag reconciles to REQUESTING', () => {
    expect(reconcileStatus('REQUESTED', record({ state: 'REQUESTING' }))).toBe('REQUESTING');
  });

  it('REQUESTING flagged NO_ACKNOWLEDGEMENT reconciles to REQUESTING_UNCONFIRMED, never a rejection-sounding status', () => {
    const lifecycle = record({ state: 'REQUESTING', lastInternalFailureKind: 'NO_ACKNOWLEDGEMENT' });
    expect(reconcileStatus('REQUESTED', lifecycle)).toBe('REQUESTING_UNCONFIRMED');
  });

  it('ACKNOWLEDGED reconciles to a distinct, honest waiting-for-data status - never ACTIVE, never RECEIVING_FRESH', () => {
    const lifecycle = record({ state: 'ACKNOWLEDGED', acknowledgementKind: 'MARKET_DATA_TYPE', marketDataType: 1 });
    expect(reconcileStatus('SUBSCRIPTION_ACTIVE', lifecycle)).toBe('ACKNOWLEDGED_WAITING_FOR_DATA');
  });

  it('ACTIVE defers to the freshness-aware lineState (RECEIVING_FRESH/RECEIVING_STALE) rather than the coarser ACTIVE label', () => {
    const lifecycle = record({ state: 'ACTIVE' });
    expect(reconcileStatus('RECEIVING_FRESH', lifecycle)).toBe('RECEIVING_FRESH');
    expect(reconcileStatus('RECEIVING_STALE', lifecycle)).toBe('RECEIVING_STALE');
    expect(reconcileStatus('SUBSCRIPTION_ACTIVE', lifecycle)).toBe('ACTIVE'); // no freshness signal available - honest fallback
  });

  it('REJECTED_NONRETRYABLE (e.g. contract-resolution failure, code 200) is surfaced distinctly, never conflated with a retryable rejection', () => {
    expect(reconcileStatus('ERROR', record({ state: 'REJECTED_NONRETRYABLE' }))).toBe('REJECTED_NONRETRYABLE');
  });

  it('no IBKR lifecycle evidence at all (non-IBKR backend, or symbol never tracked) falls back honestly to the older lineState classification', () => {
    expect(reconcileStatus('RECEIVING_FRESH', null)).toBe('RECEIVING_FRESH');
  });
});
