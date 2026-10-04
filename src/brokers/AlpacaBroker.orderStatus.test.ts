import { describe, it, expect } from 'vitest';
import { mapAlpacaOrderStatus } from './AlpacaBroker';
import { TERMINAL_ORDER_STATUSES, isTerminalOrderStatus } from '../server/services/OrderManagement';

// P1-12 (2026-10-04): orders()/placeOrder()/getOrderByClientOrderId() used to pass Alpaca's raw
// status straight through `.toUpperCase()` - done_for_day/expired/stopped/suspended were never
// recognized as terminal by OMS, so a dead DAY order was treated as still open: followUpOpenOrders()
// kept attempting to cancel it, Alpaca 422'd every time, and that repeated failure eventually
// triggered pauseTradingForOrphan() - a real nightly trading-halt bug.
describe('mapAlpacaOrderStatus', () => {
  it.each([
    ['done_for_day'], ['expired'], ['stopped'], ['suspended'], ['canceled'], ['replaced'],
  ])('maps dead/unfillable status %s to CANCELED, recognized as terminal by OMS', (raw) => {
    const mapped = mapAlpacaOrderStatus(raw);
    expect(mapped).toBe('CANCELED');
    expect(isTerminalOrderStatus(mapped)).toBe(true);
  });

  it('maps filled to FILLED (terminal)', () => {
    expect(mapAlpacaOrderStatus('filled')).toBe('FILLED');
    expect(isTerminalOrderStatus('FILLED')).toBe(true);
  });

  it('maps rejected to REJECTED (terminal)', () => {
    expect(mapAlpacaOrderStatus('rejected')).toBe('REJECTED');
    expect(isTerminalOrderStatus('REJECTED')).toBe(true);
  });

  it('maps partially_filled to PARTIALLY_FILLED (not terminal)', () => {
    const mapped = mapAlpacaOrderStatus('partially_filled');
    expect(mapped).toBe('PARTIALLY_FILLED');
    expect(isTerminalOrderStatus(mapped)).toBe(false);
  });

  it.each([
    ['new'], ['accepted'], ['pending_new'], ['accepted_for_bidding'], ['held'], ['calculated'],
    ['pending_cancel'], ['pending_replace'],
  ])('maps genuinely still-working status %s to PENDING (not terminal - never abandoned early)', (raw) => {
    const mapped = mapAlpacaOrderStatus(raw);
    expect(mapped).toBe('PENDING');
    expect(isTerminalOrderStatus(mapped)).toBe(false);
  });

  it('is case-insensitive (Alpaca always sends lowercase, but this must not depend on that)', () => {
    expect(mapAlpacaOrderStatus('DONE_FOR_DAY')).toBe('CANCELED');
    expect(mapAlpacaOrderStatus('Filled')).toBe('FILLED');
  });

  it('fails closed to PENDING (never silently CANCELED/FILLED) for an unrecognized future status', () => {
    expect(mapAlpacaOrderStatus('some_future_status_not_yet_reviewed')).toBe('PENDING');
  });

  it('every mapped value is one TERMINAL_ORDER_STATUSES or OMS already recognizes as non-terminal', () => {
    const allRaw = ['new', 'partially_filled', 'filled', 'done_for_day', 'canceled', 'expired',
      'replaced', 'pending_cancel', 'pending_replace', 'accepted', 'pending_new',
      'accepted_for_bidding', 'stopped', 'rejected', 'suspended', 'calculated', 'held'];
    for (const raw of allRaw) {
      const mapped = mapAlpacaOrderStatus(raw);
      expect(['PENDING', 'FILLED', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED']).toContain(mapped);
    }
    // Sanity: the terminal set this mapping relies on hasn't silently changed shape.
    expect(TERMINAL_ORDER_STATUSES).toContain('CANCELED');
    expect(TERMINAL_ORDER_STATUSES).toContain('FILLED');
    expect(TERMINAL_ORDER_STATUSES).toContain('REJECTED');
  });
});
