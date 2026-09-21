import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadIbkrConnection } from '../../server/config/ibkrConnection';

/**
 * 2026-09-20 remediation regression suite for the Sept 18 rejection-triggered subscription
 * desync. Verified defect: `subscribeMarketData()` set `symbolToTicker` optimistically before
 * IBKR's response was known, and only cleared it on an explicit unsubscribe - never on a
 * rejection. A symbol IBKR rejected with 354/10089 was therefore never retried again without an
 * external trigger (confirmed live: 32 symbols starved ~4h11m on 2026-09-18 until an operator
 * manually forced a resubscribe). This suite proves the bounded per-symbol retry/backoff that
 * replaces that silent-forever behavior, using the config's real schedule
 * ([60000,120000,300000,600000,900000]ms) and fake timers for determinism.
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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.disconnect();
  sockets.length = 0;
  vi.useRealTimers();
});

const BACKOFF = [60000, 120000, 300000, 600000, 900000];

describe('IBKR subscription rejection-retry (Sept 18 desync remediation)', () => {
  it('1/2. 10089 (and 354) clears active/request bookkeeping but preserves desired intent', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('additional subscription required'), 10089, tickerId);

    // desired intent preserved
    expect(() => s.subscribeMarketData('AAPL')).not.toThrow(); // no cap error - still counted as desired
    const state = s.getSubscriptionState('AAPL');
    expect(state?.state).toBe('RETRY_WAIT');
    expect(state?.lastErrorCode).toBe(10089);
    expect(state?.retryCount).toBe(1);

    // 354 behaves identically
    const s2 = session(); const socket2 = await connect(s2);
    const t2 = s2.subscribeMarketData('MSFT');
    socket2.emit(EventName.error, new Error('not subscribed'), 354, t2);
    expect(s2.getSubscriptionState('MSFT')?.state).toBe('RETRY_WAIT');
  });

  it('3. rejected symbol before cooldown expires -> no retry request', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);
    expect(socket.reqMktData).toHaveBeenCalledTimes(1); // only the initial request

    await vi.advanceTimersByTimeAsync(30_000); // one sweep tick, well before the 60s cooldown
    expect(socket.reqMktData).toHaveBeenCalledTimes(1);
  });

  it('4. cooldown expires -> exactly one new reqMktData request', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);
    expect(socket.reqMktData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 5_000); // past cooldown + one sweep tick
    expect(socket.reqMktData).toHaveBeenCalledTimes(2);
    const [, contract] = socket.reqMktData.mock.calls[1];
    expect(contract.symbol).toBe('AAPL');
  });

  it('5. multiple rescue cycles during cooldown -> still exactly zero extra requests', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);
    expect(socket.reqMktData).toHaveBeenCalledTimes(1);

    // Simulate many rescue/discovery cycles calling subscribeMarketData repeatedly during cooldown.
    for (let i = 0; i < 20; i++) {
      expect(() => s.subscribeMarketData('AAPL')).not.toThrow();
    }
    expect(socket.reqMktData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000); // still within cooldown
    for (let i = 0; i < 20; i++) s.subscribeMarketData('AAPL');
    expect(socket.reqMktData).toHaveBeenCalledTimes(1);
  });

  it('6. multiple callers right after cooldown expires -> still only one retry request', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);

    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 1_000);
    // The sweep itself already retried once - additional synchronous callers must not double-fire.
    for (let i = 0; i < 10; i++) s.subscribeMarketData('AAPL');
    expect(socket.reqMktData).toHaveBeenCalledTimes(2);
  });

  it('7. a real live tick after retry marks ACTIVE and resets retry counter/backoff', async () => {
    const s = session(); const socket = await connect(s);
    const received: any[] = [];
    s.setTickHandler((symbol, price) => received.push({ symbol, price }));
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);
    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 1_000);
    expect(socket.reqMktData).toHaveBeenCalledTimes(2);
    const newTickerId = socket.reqMktData.mock.calls[1][0];

    socket.emit('tickPrice', newTickerId, 4, 191.5); // real LAST tick
    expect(received).toEqual([{ symbol: 'AAPL', price: 191.5 }]);
    const state = s.getSubscriptionState('AAPL');
    expect(state?.state).toBe('ACTIVE');
    expect(state?.retryCount).toBe(0);
    expect(state?.nextRetryAt).toBeNull();
  });

  it('8. symbol removed from desired set while waiting -> scheduled retry does not execute', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);
    s.cancelMarketDataBySymbol('AAPL'); // desire withdrawn mid-cooldown

    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 5_000);
    expect(socket.reqMktData).toHaveBeenCalledTimes(1); // no retry ever issued
    expect(s.getSubscriptionState('AAPL')).toBeNull();
  });

  it('9. error 200 preserves the existing contract-resolution path, not the rejection-retry state machine', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('SQ');
    socket.emit(EventName.error, new Error('No security definition has been found for the request'), 200, tickerId);
    // A record exists (created unconditionally when the request was issued) but handleMarketDataError
    // never transitions it away from REQUESTING for code 200 - this fix's state machine is untouched.
    expect(s.getSubscriptionState('SQ')?.state).toBe('REQUESTING');
    expect(s.getSubscriptionState('SQ')?.lastErrorCode).toBeNull();
    // Even past the confirmation timeout + full backoff window, the sweep must not retry a symbol
    // whose last recorded error is the non-retryable code 200.
    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 5_000);
    expect(socket.reqMktData).toHaveBeenCalledTimes(1); // no automatic retry issued by this fix for code 200
    expect(s.getSubscriptionState('SQ')?.state).toBe('REQUESTING');
  });

  it('10. 10197 remains separate from 354/10089 behavior', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('No market data during competing live session'), 10197, tickerId);
    expect(s.getSubscriptionState('AAPL')?.state).toBe('REQUESTING'); // untouched by this fix's state machine
    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 5_000);
    expect(socket.reqMktData).toHaveBeenCalledTimes(1); // no retry - 10197 stays out of scope
    expect(s.getSubscriptionState('AAPL')?.state).toBe('REQUESTING');
  });

  it('11. disconnect/reconnect after rejection -> exactly one reissue, no duplicate subscriptions', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId); // now RETRY_WAIT, cooldown ~60s away

    socket.emit('disconnected'); // transport loss, well before cooldown expiry
    const next = await connect(s); // reconnect
    expect(next.reqMktData).toHaveBeenCalledTimes(1); // exactly one reissue on reconnect, not blocked by stale cooldown
    expect(s.getSubscriptionState('AAPL')?.state).toBe('REQUESTING');

    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 5_000);
    expect(next.reqMktData).toHaveBeenCalledTimes(1); // no duplicate/second request from the old cooldown timer
  });

  it('12. a stale old-generation error callback cannot alter the current subscription state', async () => {
    const s = session(); const socket = await connect(s);
    const oldTickerId = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, oldTickerId); // AAPL -> RETRY_WAIT
    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 1_000);
    const newTickerId = socket.reqMktData.mock.calls[1][0];
    socket.emit('tickPrice', newTickerId, 4, 100); // recovers -> ACTIVE

    // A late error for the OLD (already-superseded) tickerId must not corrupt the now-ACTIVE state.
    socket.emit(EventName.error, new Error('late'), 10089, oldTickerId);
    expect(s.getSubscriptionState('AAPL')?.state).toBe('ACTIVE');
  });

  it('13. unsubscribe (cancelMarketDataBySymbol) is idempotent', async () => {
    const s = session(); await connect(s);
    s.subscribeMarketData('AAPL');
    expect(() => { s.cancelMarketDataBySymbol('AAPL'); s.cancelMarketDataBySymbol('AAPL'); }).not.toThrow();
  });

  it('14. ticker mappings do not leak across retries', async () => {
    const s = session(); const socket = await connect(s);
    const tickerId1 = s.subscribeMarketData('AAPL');
    socket.emit(EventName.error, new Error('x'), 10089, tickerId1);
    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 1_000);
    const tickerId2 = socket.reqMktData.mock.calls[1][0];
    expect(tickerId2).not.toBe(tickerId1);
    // A late tick for the OLD ticker id must not resolve to AAPL anymore (mapping cleared).
    const received: any[] = [];
    s.setTickHandler((symbol, price) => received.push({ symbol, price }));
    socket.emit('tickPrice', tickerId1, 4, 999);
    expect(received).toHaveLength(0);
  });

  it('15. 90/90 capacity is measured against active broker lines, not desired intent - a rejected symbol releases its line for a new candidate (Phase 2 fix)', async () => {
    const s = session({ maxMarketDataLines: 1 } as any); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('AAPL');
    expect(() => s.subscribeMarketData('MSFT')).toThrow(/cap/); // AAPL holds the only active line
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);
    // AAPL is REJECTED (RETRY_WAIT) - it no longer holds a real IBKR line, so MSFT can now acquire
    // the freed capacity. AAPL remains fully DESIRED (still in the retry schedule) - desired intent
    // and active broker-line occupancy are deliberately two different things (Phase 2 remediation:
    // the pre-fix behavior let a rejected symbol block a 91st candidate forever).
    expect(() => s.subscribeMarketData('MSFT')).not.toThrow();
    expect(s.getSubscriptionState('AAPL')?.state).toBe('RETRY_WAIT'); // still desired, still tracked
    // With MSFT now holding the only line, a third symbol is correctly capped again.
    expect(() => s.subscribeMarketData('NVDA')).toThrow(/cap/);
  });

  it('16. delayed tick fields 66-69 remain isolated and do not mark the subscription ACTIVE/healthy', async () => {
    const s = session(); const socket = await connect(s);
    const delayed: any[] = [];
    const live: any[] = [];
    s.setDelayedTickHandler((symbol, field, price) => delayed.push({ symbol, field, price }));
    s.setTickHandler((symbol, price) => live.push({ symbol, price }));
    const tickerId = s.subscribeMarketData('AAPL');

    // Delayed data arrives while the request is still live/tracked (before any rejection) - proves
    // a delayed tick alone can never mark the subscription ACTIVE/healthy, which is the actual
    // safety property this test protects (a live tick doing so is covered by test 7).
    socket.emit('tickPrice', tickerId, 68, 100.5); // DELAYED_LAST
    expect(delayed).toEqual([{ symbol: 'AAPL', field: 68, price: 100.5 }]);
    expect(live).toHaveLength(0);
    expect(s.getSubscriptionState('AAPL')?.state).toBe('REQUESTING'); // NOT ACTIVE - delayed data never proves success

    // A subsequent real rejection still behaves normally - delayed data did not mask it.
    socket.emit(EventName.error, new Error('x'), 10089, tickerId);
    expect(s.getSubscriptionState('AAPL')?.state).toBe('RETRY_WAIT');
  });

  it('17 (Phase 2 rewrite, supersedes the pre-audit version): silent non-response is NEVER treated as a rejection - it is flagged NO_ACKNOWLEDGEMENT and self-heals via the slow REPROBE path, never RETRY_WAIT, never a fake error code', async () => {
    // 2026-09-21 post-fix adversarial audit finding: the ORIGINAL Sept-18 remediation treated 60s
    // of silence identically to an explicit rejection (synthetic errorCode=-1 -> RETRY_WAIT). Real
    // runtime verification of that fix happened to run on a fully closed Sunday market, where
    // silence is expected, not evidence of failure - this test proves the corrected behavior.
    const s = session(); const socket = await connect(s);
    const tickerId = s.subscribeMarketData('XOM');
    socket.emit(EventName.error, new Error('additional subscription required'), 10089, tickerId);
    expect(socket.reqMktData).toHaveBeenCalledTimes(1);
    expect(s.getSubscriptionState('XOM')?.state).toBe('RETRY_WAIT'); // real, explicit error - unchanged Sept-18 behavior

    // Cooldown expires; sweep retries. This time IBKR is totally silent - no tick, no error at all.
    await vi.advanceTimersByTimeAsync(BACKOFF[0] + 1_000);
    expect(socket.reqMktData).toHaveBeenCalledTimes(2);
    expect(s.getSubscriptionState('XOM')?.state).toBe('REQUESTING');

    // Discovery/rescue keeps calling subscribeMarketData every cycle - must remain a no-op while
    // REQUESTING (an existing ticker mapping already exists).
    for (let i = 0; i < 10; i++) s.subscribeMarketData('XOM');
    expect(socket.reqMktData).toHaveBeenCalledTimes(2);

    // Confirmation timeout (60s) elapses with neither a tick nor an error. This must NEVER become a
    // rejection: state stays REQUESTING, retryCount is untouched, only an honest diagnostic flag is set.
    await vi.advanceTimersByTimeAsync(60_000 + 5_000);
    const stateAfterTimeout = s.getSubscriptionState('XOM');
    expect(stateAfterTimeout?.state).toBe('REQUESTING');
    expect(stateAfterTimeout?.lastInternalFailureKind).toBe('NO_ACKNOWLEDGEMENT');
    // lastErrorCode still legitimately holds the real prior 10089 (a real broker code is never
    // cleared just because a later request went quiet) - the point is it was NEVER overwritten
    // with a synthetic/internal value (e.g. -1) the way the pre-Phase-2 implementation did.
    expect(stateAfterTimeout?.lastErrorCode).toBe(10089);
    expect(stateAfterTimeout?.retryCount).toBe(1); // unchanged from the one real 10089 above - silence never increments it
    expect(socket.reqMktData).toHaveBeenCalledTimes(2); // still no new request from silence alone

    // Well past the much slower, much less aggressive reprobe window - a bounded self-healing
    // reissue fires (REPROBE, distinct from RETRY), still landing in REQUESTING, not RETRY_WAIT.
    await vi.advanceTimersByTimeAsync(loadIbkrConnection().marketDataUnconfirmedReprobeMs + 1_000);
    expect(socket.reqMktData).toHaveBeenCalledTimes(3);
    const reprobed = s.getSubscriptionState('XOM');
    // Still REQUESTING (never RETRY_WAIT) and the explicit-rejection retry counter is still
    // untouched by any of this silence/reprobe activity - the two load-bearing guarantees. Whether
    // lastInternalFailureKind has already been re-flagged by a later sweep tick (a second period of
    // silence since the reprobe's own fresh request) is a real, legitimate possibility depending on
    // exact sweep-tick/advance-window alignment, not asserted here to avoid a timing-fragile test.
    expect(reprobed?.state).toBe('REQUESTING');
    expect(reprobed?.retryCount).toBe(1); // reprobe never touches the explicit-rejection retry counter

    // Real data finally arrives on the reprobed ticker - full recovery.
    const finalTickerId = socket.reqMktData.mock.calls[2][0];
    socket.emit('tickPrice', finalTickerId, 4, 105.0);
    const recovered = s.getSubscriptionState('XOM');
    expect(recovered?.state).toBe('ACTIVE');
    expect(recovered?.retryCount).toBe(0);

    // If 10089 repeats after this, it correctly returns to RETRY_WAIT with fresh backoff from 1 -
    // this fix never claims to have resolved IBKR's own account-side entitlement problem.
    socket.emit(EventName.error, new Error('x'), 10089, finalTickerId);
    const rejectedAgain = s.getSubscriptionState('XOM');
    expect(rejectedAgain?.state).toBe('RETRY_WAIT');
    expect(rejectedAgain?.retryCount).toBe(1);
  });
});
