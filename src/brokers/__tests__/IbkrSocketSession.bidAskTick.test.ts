import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadIbkrConnection } from '../../server/config/ibkrConnection';

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

const sessions: IbkrSocketSession[] = [];
const session = () => { const s = new IbkrSocketSession({ ...loadIbkrConnection(), maxMarketDataLines: 10 }); sessions.push(s); return s; };
async function connect(s: IbkrSocketSession) {
  const before = sockets.length;
  const pending = s.connect();
  for (let n = 0; sockets.length === before && n < 20; n++) await Promise.resolve();
  const socket = sockets.at(-1);
  socket.emit('connected'); socket.emit('managedAccounts', 'DU123456');
  expect(await pending).toBe(true);
  return socket;
}
afterEach(async () => { for (const s of sessions.splice(0)) await s.disconnect(); sockets.length = 0; });

/**
 * Real, reproduced defect (2026-09-23 extended-hours spread forensic follow-up): IBKR already
 * sends discrete, correctly field-typed live BID(1)/ASK(2)/LAST(4) ticks - the tickPrice handler
 * comment even says so - but every field collapsed into tickHandler's single (symbol, price) call,
 * so MarketDataWorker.latestAskPrices (the only source of a real bid/ask spread anywhere in this
 * codebase, and the exact input RiskEngine's gate 25 extended_hours_execution_policy depends on)
 * could never be populated while IBKR is the active quote backend - not "sometimes missing", but
 * structurally guaranteed null for every symbol under every condition. setBidAskTickHandler is the
 * fix: a second, additive sink carrying the field type through, alongside (never replacing)
 * tickHandler.
 */
describe('IbkrSocketSession live bid/ask tick propagation (2026-09-23 extended-hours spread forensic follow-up)', () => {
  it('routes real live BID(1)/ASK(2)/LAST(4) ticks to BOTH tickHandler (unchanged) and the new bidAskTickHandler (field-typed)', async () => {
    const s = session(); const socket = await connect(s);
    const live: any[] = [];
    const bidAsk: any[] = [];
    s.setTickHandler((symbol, price) => live.push({ symbol, price }));
    s.setBidAskTickHandler((symbol, field, price) => bidAsk.push({ symbol, field, price }));
    const tickerId = s.subscribeMarketData('TSLA');

    socket.emit('tickPrice', tickerId, 1, 250.10); // BID
    socket.emit('tickPrice', tickerId, 2, 250.30); // ASK
    socket.emit('tickPrice', tickerId, 4, 250.20); // LAST

    // tickHandler's existing behavior is byte-for-byte unchanged - still receives all three, still
    // collapsed to (symbol, price) - this fix never touches that path.
    expect(live).toEqual([
      { symbol: 'TSLA', price: 250.10 },
      { symbol: 'TSLA', price: 250.30 },
      { symbol: 'TSLA', price: 250.20 },
    ]);
    // The new sink carries the field type through - this is what was structurally impossible before.
    expect(bidAsk).toEqual([
      { symbol: 'TSLA', field: 1, price: 250.10 },
      { symbol: 'TSLA', field: 2, price: 250.30 },
      { symbol: 'TSLA', field: 4, price: 250.20 },
    ]);
  });

  it('delayed ticks (66-69) never reach bidAskTickHandler - same isolation contract as delayedTickHandler/tickHandler', async () => {
    const s = session(); const socket = await connect(s);
    const bidAsk: any[] = [];
    s.setBidAskTickHandler((symbol, field, price) => bidAsk.push({ symbol, field, price }));
    const tickerId = s.subscribeMarketData('AAPL');

    socket.emit('tickPrice', tickerId, 67, 190.5); // DELAYED_ASK

    expect(bidAsk).toHaveLength(0);
  });

  it('with no bidAskTickHandler registered (the pre-fix default), a live tick does not throw and tickHandler still fires normally', async () => {
    const s = session(); const socket = await connect(s);
    const live: any[] = [];
    s.setTickHandler((symbol, price) => live.push({ symbol, price }));
    const tickerId = s.subscribeMarketData('MSFT');

    expect(() => socket.emit('tickPrice', tickerId, 2, 420.0)).not.toThrow();
    expect(live).toEqual([{ symbol: 'MSFT', price: 420.0 }]);
  });
});
