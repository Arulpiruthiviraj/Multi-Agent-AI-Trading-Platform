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

describe('IbkrSocketSession delayed-tick isolation (2026-09-20 remediation, part D)', () => {
  it('recognizes delayed tick fields 66-69 and routes them to the delayed handler, never the live tickHandler', async () => {
    const s = session(); const socket = await connect(s);
    const live: any[] = [];
    const delayed: any[] = [];
    s.setTickHandler((symbol, price) => live.push({ symbol, price }));
    s.setDelayedTickHandler((symbol, field, price) => delayed.push({ symbol, field, price }));
    const tickerId = s.subscribeMarketData('AAPL');

    socket.emit('tickPrice', tickerId, 66, 100.1); // DELAYED_BID
    socket.emit('tickPrice', tickerId, 67, 100.2); // DELAYED_ASK
    socket.emit('tickPrice', tickerId, 68, 100.3); // DELAYED_LAST
    socket.emit('tickPrice', tickerId, 69, 100.4); // DELAYED_CLOSE

    expect(live).toHaveLength(0);
    expect(delayed).toEqual([
      { symbol: 'AAPL', field: 66, price: 100.1 },
      { symbol: 'AAPL', field: 67, price: 100.2 },
      { symbol: 'AAPL', field: 68, price: 100.3 },
      { symbol: 'AAPL', field: 69, price: 100.4 },
    ]);
  });

  it('live fields (1=bid, 2=ask, 4=last) still route only to the live tickHandler, never the delayed one', async () => {
    const s = session(); const socket = await connect(s);
    const live: any[] = [];
    const delayed: any[] = [];
    s.setTickHandler((symbol, price) => live.push({ symbol, price }));
    s.setDelayedTickHandler((symbol, field, price) => delayed.push({ symbol, field, price }));
    const tickerId = s.subscribeMarketData('AAPL');

    socket.emit('tickPrice', tickerId, 1, 191.0);
    socket.emit('tickPrice', tickerId, 2, 191.1);
    socket.emit('tickPrice', tickerId, 4, 191.05);

    expect(delayed).toHaveLength(0);
    expect(live).toEqual([{ symbol: 'AAPL', price: 191.0 }, { symbol: 'AAPL', price: 191.1 }, { symbol: 'AAPL', price: 191.05 }]);
  });

  it('an unrelated/unknown tick field (neither live nor delayed) is dropped by both handlers', async () => {
    const s = session(); const socket = await connect(s);
    const live: any[] = [];
    const delayed: any[] = [];
    s.setTickHandler((symbol, price) => live.push({ symbol, price }));
    s.setDelayedTickHandler((symbol, field, price) => delayed.push({ symbol, field, price }));
    const tickerId = s.subscribeMarketData('AAPL');

    socket.emit('tickPrice', tickerId, 9, 190.5); // CLOSE - neither live top-of-book nor delayed
    expect(live).toHaveLength(0);
    expect(delayed).toHaveLength(0);
  });
});
