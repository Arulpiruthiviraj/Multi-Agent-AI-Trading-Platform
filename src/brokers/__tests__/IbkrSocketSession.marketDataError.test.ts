import { describe, it, expect, vi } from 'vitest';
import { IbkrSocketSession } from '../IbkrSocketSession';

/**
 * Regression tests for the 2026-09-04 opportunity-capture remediation fix: IB's `error` event for
 * an active reqMktData request (e.g. code 354 "Requested market data is not subscribed") used to
 * be silently dropped once the initial connect() promise had settled — a symbol could sit in
 * MarketDataWorker's "active" bookkeeping forever with zero real ticks and no diagnostic trail.
 * These tests exercise the internal reqId -> symbol -> handler wiring directly (via `as any`,
 * matching this codebase's existing pattern in MarketDataWorker.test.ts) since a real IB Gateway
 * TCP connection is out of scope for a unit test — `connect()` itself is not what changed.
 */
describe('IbkrSocketSession market-data error surfacing', () => {
  it('does nothing for a reqId with no tracked active market-data symbol', () => {
    const session = new IbkrSocketSession();
    const handler = vi.fn();
    session.setMarketDataErrorHandler(handler);
    (session as any).handleMarketDataError(9999, 354, 'Requested market data is not subscribed.');
    expect(handler).not.toHaveBeenCalled();
    expect(session.getMarketDataError('NVDA')).toBeNull();
  });

  it('invokes the handler and records the error for a known active reqId', () => {
    const session = new IbkrSocketSession();
    (session as any).activeMktData.set(42, 'NVDA');
    const handler = vi.fn();
    session.setMarketDataErrorHandler(handler);

    (session as any).handleMarketDataError(42, 354, 'Requested market data is not subscribed.');

    expect(handler).toHaveBeenCalledWith('NVDA', 354, 'Requested market data is not subscribed.');
    const recorded = session.getMarketDataError('NVDA');
    expect(recorded).not.toBeNull();
    expect(recorded?.code).toBe(354);
    expect(recorded?.message).toBe('Requested market data is not subscribed.');
    expect(typeof recorded?.atMs).toBe('number');
  });

  it('is case-insensitive on getMarketDataError lookup', () => {
    const session = new IbkrSocketSession();
    (session as any).activeMktData.set(7, 'AAPL');
    (session as any).handleMarketDataError(7, 200, 'No security definition has been found.');
    expect(session.getMarketDataError('aapl')?.code).toBe(200);
  });

  it('never lets a throwing handler break the session (fail-open)', () => {
    const session = new IbkrSocketSession();
    (session as any).activeMktData.set(1, 'TSLA');
    session.setMarketDataErrorHandler(() => {
      throw new Error('downstream sink exploded');
    });
    expect(() => (session as any).handleMarketDataError(1, 354, 'boom')).not.toThrow();
    // The record is still kept even though the handler blew up.
    expect(session.getMarketDataError('TSLA')?.code).toBe(354);
  });

  it('setMarketDataErrorHandler(null) stops future callbacks without clearing prior records', () => {
    const session = new IbkrSocketSession();
    (session as any).activeMktData.set(3, 'MSFT');
    const handler = vi.fn();
    session.setMarketDataErrorHandler(handler);
    (session as any).handleMarketDataError(3, 354, 'first');
    session.setMarketDataErrorHandler(null);
    (session as any).handleMarketDataError(3, 354, 'second');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(session.getMarketDataError('MSFT')?.message).toBe('second');
  });

  it('clears a tracked error when the symbol is freshly re-subscribed', () => {
    const session = new IbkrSocketSession();
    (session as any).activeMktData.set(5, 'META');
    (session as any).handleMarketDataError(5, 354, 'stale rejection');
    expect(session.getMarketDataError('META')).not.toBeNull();

    // Fake a connected IB session so subscribeMarketData() doesn't refuse.
    (session as any).connected = true;
    (session as any).ib = { reqMktData: vi.fn() };
    // Existing symbolToTicker entry would short-circuit as "already subscribed" - clear it first
    // to simulate a real fresh re-subscribe after an eviction+re-admission cycle.
    (session as any).symbolToTicker.delete('META');
    (session as any).activeMktData.delete(5);

    session.subscribeMarketData('META');
    expect(session.getMarketDataError('META')).toBeNull();
  });

  it('clears a tracked error on cancelMarketDataBySymbol', () => {
    const session = new IbkrSocketSession();
    (session as any).activeMktData.set(11, 'AMD');
    (session as any).symbolToTicker.set('AMD', 11);
    (session as any).handleMarketDataError(11, 354, 'rejected');
    expect(session.getMarketDataError('AMD')).not.toBeNull();

    (session as any).ib = { cancelMktData: vi.fn() };
    session.cancelMarketDataBySymbol('AMD');
    expect(session.getMarketDataError('AMD')).toBeNull();
  });
});
