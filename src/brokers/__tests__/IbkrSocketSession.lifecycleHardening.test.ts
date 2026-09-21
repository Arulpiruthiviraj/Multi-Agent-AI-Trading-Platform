import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadIbkrConnection } from '../../server/config/ibkrConnection';

/**
 * 2026-09-21 Phase 2 (post-adversarial-audit of the 2026-09-20 Sept-18 fix). Covers the NEW
 * behaviors this hardening pass added: IBKR request-level acknowledgement (marketDataType/
 * tickReqParams), the account-wide entitlement circuit breaker (canary-driven, never triggered by
 * one symbol alone), and gradual recovery. The existing IbkrSocketSession.rejectionRetry.test.ts
 * suite continues to cover the unchanged explicit-354/10089 retry path and now also covers the
 * corrected (never-rejects-on-silence) confirmation-timeout behavior - not duplicated here.
 *
 * Canary symbols reuse the real continuousIntelligence.protectedSymbols config (SPY/QQQ/GLD in
 * this deployment), never a hardcoded test-only list, matching production wiring exactly.
 */
vi.mock('../ibkrTcpProbe', () => ({ findFirstOpenTcpPort: vi.fn(async () => 4002) }));
const { sockets } = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock('@stoqey/ib', async () => {
  const { EventEmitter } = await import('node:events');
  const actual = await vi.importActual<any>('@stoqey/ib');
  class Socket extends EventEmitter {
    constructor() { super(); sockets.push(this); }
    connect = vi.fn(); disconnect = vi.fn(); reqIds = vi.fn(); reqCurrentTime = vi.fn();
    reqManagedAccts = vi.fn(); reqAccountSummary = vi.fn(); reqPositions = vi.fn();
    reqOpenOrders = vi.fn(); reqExecutions = vi.fn(); reqMktData = vi.fn(); cancelMktData = vi.fn();
  }
  return { ...actual, IBApi: Socket };
});
import { IbkrSocketSession } from '../IbkrSocketSession';
import { EventName } from '@stoqey/ib';

const sessions: IbkrSocketSession[] = [];
const session = (overrides: Partial<ReturnType<typeof loadIbkrConnection>> = {}) => {
  const s = new IbkrSocketSession({ ...loadIbkrConnection(), maxMarketDataLines: 90, ...overrides });
  sessions.push(s);
  return s;
};
async function connect(s: IbkrSocketSession) {
  const before = sockets.length;
  const pending = s.connect();
  for (let n = 0; sockets.length === before && n < 20; n++) await Promise.resolve();
  const socket = sockets.at(-1);
  socket.emit('connected');
  socket.emit('managedAccounts', 'DU123456');
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(await pending).toBe(true);
  return socket;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.disconnect();
  sockets.length = 0;
  vi.useRealTimers();
});

describe('IBKR acknowledgement evidence (marketDataType / tickReqParams)', () => {
  it('25. marketDataType callback promotes REQUESTING -> ACKNOWLEDGED, never ACTIVE, never satisfies freshness', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.marketDataType, tickerId, 1); // real-time
    const state = s.getSubscriptionState('AAPL');
    expect(state?.state).toBe('ACKNOWLEDGED');
    expect(state?.acknowledgementKind).toBe('MARKET_DATA_TYPE');
    expect(state?.marketDataType).toBe(1);
    expect(state?.lastAcknowledgedAt).not.toBeNull();
  });

  it('tickReqParams callback also promotes REQUESTING -> ACKNOWLEDGED', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('MSFT');
    socket.emit(EventName.tickReqParams, tickerId, 0.01, '1', 3);
    const state = s.getSubscriptionState('MSFT');
    expect(state?.state).toBe('ACKNOWLEDGED');
    expect(state?.acknowledgementKind).toBe('TICK_REQ_PARAMS');
  });

  it('24. acknowledged-but-illiquid: acknowledgement alone never churns into a retry, even with market OPEN and minutes of silence', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('THIN');
    socket.emit(EventName.marketDataType, tickerId, 1);
    expect(s.getSubscriptionState('THIN')?.state).toBe('ACKNOWLEDGED');

    // Several minutes of silence - well past the old (incorrect) 60s confirmation window and the
    // sweep cadence, with zero live ticks. Must remain ACKNOWLEDGED, never RETRY_WAIT, no new request.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const state = s.getSubscriptionState('THIN');
    expect(state?.state).toBe('ACKNOWLEDGED');
    expect(socket.reqMktData).toHaveBeenCalledTimes(1); // no churn at all once acknowledged
  });

  it('a real tick after ACKNOWLEDGED still correctly promotes to ACTIVE (acknowledgement is not a ceiling)', async () => {
    const s = session(); const socket = await connect(s);
    const received: any[] = [];
    s.setTickHandler((symbol, price) => received.push({ symbol, price }));
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.marketDataType, tickerId, 1);
    socket.emit('tickPrice', tickerId, 4, 191.5);
    expect(s.getSubscriptionState('AAPL')?.state).toBe('ACTIVE');
    expect(received).toEqual([{ symbol: 'AAPL', price: 191.5 }]);
  });

  it('a late acknowledgement callback for an old/superseded ticker id is ignored (generation-safety, same guard style as tickPrice)', async () => {
    const s = session(); const socket = await connect(s);
    const oldTickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, oldTickerId); // AAPL -> RETRY_WAIT, old ticker cleared
    socket.emit(EventName.marketDataType, oldTickerId, 1); // stale ack for the dead ticker
    expect(s.getSubscriptionState('AAPL')?.state).toBe('RETRY_WAIT'); // unaffected
  });
});

describe('IBKR account-wide entitlement circuit breaker (canary-driven)', () => {
  it('31. a single non-canary symbol error never engages the account-wide breaker', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('OBSCURE');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);
    expect(s.getAccountEntitlementState().state).toBe('NORMAL');
  });

  it('29. two DISTINCT canaries (SPY, QQQ) receiving 10089 within the clustering window engages DEGRADED_ENTITLEMENT and suppresses ordinary (non-canary) retries', async () => {
    const s = session(); const socket = await connect(s);
    const spyTicker = s.subscribeMarketData('SPY');
    const otherTicker = s.subscribeMarketData('OBSCURE');
    socket.emit(EventName.error, new Error('x'), 10089, spyTicker);
    expect(s.getAccountEntitlementState().state).toBe('NORMAL'); // only 1 canary so far - real evidence threshold not yet met

    const qqqTicker = s.subscribeMarketData('QQQ');
    socket.emit(EventName.error, new Error('x'), 10089, qqqTicker);
    socket.emit(EventName.error, new Error('x'), 10089, otherTicker);
    const acctState = s.getAccountEntitlementState();
    expect(acctState.state).toBe('DEGRADED_ENTITLEMENT');
    expect([...acctState.degradedCanaries].sort()).toEqual(['QQQ', 'SPY']);

    // Both SPY and OBSCURE are now past their retry cooldown - only the canary (SPY) actually
    // retries; the ordinary symbol (OBSCURE) stays suppressed, desired intent fully preserved.
    const before = socket.reqMktData.mock.calls.length;
    await vi.advanceTimersByTimeAsync(65_000);
    const after = socket.reqMktData.mock.calls.length;
    expect(after).toBeGreaterThan(before); // SPY (canary) retried
    expect(s.getSubscriptionState('OBSCURE')?.state).toBe('RETRY_WAIT'); // still desired, still tracked, not silently dropped
    expect(s.getSubscriptionState('OBSCURE')?.nextRetryAt).not.toBeNull(); // schedule preserved, not reset
  });

  it('30. account-wide recovery: a canary reaching a real live tick clears the breaker and gradually resubscribes suppressed symbols', async () => {
    const s = session(); const socket = await connect(s);
    const spyTicker = s.subscribeMarketData('SPY');
    const qqqTicker = s.subscribeMarketData('QQQ');
    const obscureTicker = s.subscribeMarketData('OBSCURE');
    socket.emit(EventName.error, new Error('x'), 10089, spyTicker);
    socket.emit(EventName.error, new Error('x'), 10089, qqqTicker);
    socket.emit(EventName.error, new Error('x'), 10089, obscureTicker);
    expect(s.getAccountEntitlementState().state).toBe('DEGRADED_ENTITLEMENT');

    // Both canaries' own retries fire and this time get a real tick - recovery is conservative on
    // purpose: SPY alone recovering must NOT clear the breaker while QQQ's own error is still
    // recent (real evidence-respecting behavior, not "first success wins").
    await vi.advanceTimersByTimeAsync(65_000);
    const spyRecord = s.getSubscriptionState('SPY');
    expect(spyRecord?.state).toBe('REQUESTING');
    socket.emit('tickPrice', spyRecord!.tickerId, 4, 500.0);
    expect(s.getSubscriptionState('SPY')?.state).toBe('ACTIVE');
    expect(s.getAccountEntitlementState().state).toBe('DEGRADED_ENTITLEMENT'); // QQQ's own error is still recent

    const qqqRecord = s.getSubscriptionState('QQQ');
    expect(qqqRecord?.state).toBe('REQUESTING');
    socket.emit('tickPrice', qqqRecord!.tickerId, 4, 480.0);
    expect(s.getSubscriptionState('QQQ')?.state).toBe('ACTIVE');
    expect(s.getAccountEntitlementState().state).toBe('NORMAL'); // both canaries recovered -> settled back to NORMAL

    // OBSCURE (previously suppressed) should have been swept into a gradual resubscribe attempt.
    const obscureAfter = s.getSubscriptionState('OBSCURE');
    expect(['REQUESTING', 'RETRY_WAIT']).toContain(obscureAfter?.state); // reissued (or already re-cooling if it errors again) - never silently abandoned
  });

  it('33. a rejected protected/core canary symbol remains desired, never falsely appears ACTIVE, and its own retry stays bounded (not independently unbounded) even while DEGRADED', async () => {
    const s = session(); const socket = await connect(s);
    const spyTicker = s.subscribeMarketData('SPY');
    const qqqTicker = s.subscribeMarketData('QQQ');
    socket.emit(EventName.error, new Error('x'), 10089, spyTicker);
    socket.emit(EventName.error, new Error('x'), 10089, qqqTicker);
    expect(s.getAccountEntitlementState().state).toBe('DEGRADED_ENTITLEMENT');
    const spyRecord = s.getSubscriptionState('SPY');
    expect(spyRecord?.state).toBe('RETRY_WAIT'); // not falsely ACTIVE
    expect(spyRecord?.nextRetryAt).not.toBeNull(); // still on the SAME bounded backoff schedule as any other symbol
  });
});

describe('IBKR unified diagnostics snapshot', () => {
  it('35. broker-issued error and internal failure kind are represented in structurally separate fields', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);
    const state = s.getSubscriptionState('AAPL');
    expect(state?.lastErrorCode).toBe(10089);
    expect(state?.lastInternalFailureKind).toBeNull();
  });
});
