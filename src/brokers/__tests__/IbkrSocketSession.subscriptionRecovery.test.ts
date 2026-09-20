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
const session = () => { const s = new IbkrSocketSession({ ...loadIbkrConnection(), maxMarketDataLines: 2 }); sessions.push(s); return s; };
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

describe('desired market data survives socket generations', () => {
  it('restores each request once after disconnect, accepts new ticks, and does not restore cancelled ownership', async () => {
    const s = session(); const first = await connect(s);
    const received = vi.fn(); const reissued = vi.fn();
    s.setTickHandler(received); s.setMarketDataSubscriptionHandler(reissued);
    const oldId = s.subscribeMarketData('AAPL'); const cancelledId = s.subscribeMarketData('MSFT');
    first.emit('disconnected');
    expect(s.activeMarketDataCount()).toBe(0);
    s.cancelMarketData(cancelledId);
    const next = await connect(s);
    expect(next.reqMktData).toHaveBeenCalledTimes(1);
    const [newId, contract] = next.reqMktData.mock.calls[0];
    expect(newId).not.toBe(oldId); expect(contract.symbol).toBe('AAPL');
    next.emit('managedAccounts', 'DU123456');
    expect(s.subscribeMarketData('AAPL')).toBe(newId);
    expect(next.reqMktData).toHaveBeenCalledTimes(1);
    next.emit('tickPrice', oldId, 4, 500, {});
    expect(received).not.toHaveBeenCalled();
    next.emit('tickPrice', newId, 4, 191, {});
    expect(received).toHaveBeenCalledWith('AAPL', 191);
    expect(reissued.mock.calls.map(c => c[0])).toEqual(['AAPL', 'MSFT', 'AAPL']);
    expect(s.activeMarketDataCount()).toBe(1);
  });

  it('preserves the cap through reconnect and clears intent on explicit teardown', async () => {
    const s = session(); await connect(s);
    s.subscribeMarketData('AAPL'); s.subscribeMarketData('MSFT');
    expect(() => s.subscribeMarketData('NVDA')).toThrow('cap');
    const next = await connect(s);
    expect(next.reqMktData).toHaveBeenCalledTimes(2);
    expect(() => s.subscribeMarketData('NVDA')).toThrow('cap');
    await s.disconnect();
    const final = await connect(s);
    expect(final.reqMktData).not.toHaveBeenCalled();
  });

  it('does not resurrect subscriptions when an explicit teardown interrupts a connection probe', async () => {
    const s = session(); await connect(s); s.subscribeMarketData('AAPL');
    const { findFirstOpenTcpPort } = await import('../ibkrTcpProbe');
    let complete!: (port: number) => void;
    vi.mocked(findFirstOpenTcpPort).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = s.connect();
    for (let n = 0; !complete && n < 20; n++) await Promise.resolve();
    await s.disconnect(); complete(4002);
    expect(await pending).toBe(false);
    expect(s.isConnected()).toBe(false);
  });
});
