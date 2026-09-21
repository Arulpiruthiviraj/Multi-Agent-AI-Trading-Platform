import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadIbkrConnection } from '../../server/config/ibkrConnection';
import { resetIbkrContractResolutionCacheForTests } from '../ibkrContractResolution';

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
    reqContractDetails = vi.fn();
  }
  return { ...actual, IBApi: Socket };
});
import { IbkrSocketSession } from '../IbkrSocketSession';
import { EventName } from '@stoqey/ib';

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

beforeEach(() => resetIbkrContractResolutionCacheForTests());
afterEach(async () => { for (const s of sessions.splice(0)) await s.disconnect(); sockets.length = 0; });

describe('IbkrSocketSession contract resolution (2026-09-20 remediation)', () => {
  it('never assumed correlation/resolution: a symbol never resolved gets byte-for-byte the same default contract as before this change', async () => {
    const s = session(); const socket = await connect(s);
    s.subscribeMarketData('AAPL');
    const [, contract] = socket.reqMktData.mock.calls[0];
    expect(contract).toEqual({ symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' });
  });

  it('after a RESOLVED contract, subscribeMarketData uses the qualified contract (primaryExch/conId included)', async () => {
    const s = session(); const socket = await connect(s);
    socket.reqContractDetails.mockImplementation((reqId: number) => {
      queueMicrotask(() => {
        socket.emit(EventName.contractDetails, reqId, {
          contract: { symbol: 'BRK B', secType: 'STK', exchange: 'SMART', primaryExch: 'NYSE', currency: 'USD', conId: 999 },
        });
        socket.emit(EventName.contractDetailsEnd, reqId);
      });
    });
    const outcome = await s.resolveContract('BRK B');
    expect(outcome.status).toBe('RESOLVED');

    s.subscribeMarketData('BRK B');
    const call = socket.reqMktData.mock.calls.find((c: any[]) => c[1]?.symbol === 'BRK B');
    expect(call[1]).toMatchObject({ symbol: 'BRK B', primaryExch: 'NYSE', conId: 999 });
  });

  it('AMBIGUOUS/NOT_FOUND resolution: subscribeMarketData refuses rather than sending an unverified guess for a different security', async () => {
    const s = session(); const socket = await connect(s);
    socket.reqContractDetails.mockImplementation((reqId: number) => {
      queueMicrotask(() => socket.emit(EventName.contractDetailsEnd, reqId)); // 0 matches -> NOT_FOUND
    });
    const outcome = await s.resolveContract('SQ');
    expect(outcome.status).toBe('NOT_FOUND');

    expect(() => s.subscribeMarketData('SQ')).toThrow(/could not be uniquely resolved/);
    // Never silently proceeded with a guessed contract for a different/unverified security.
    expect(socket.reqMktData.mock.calls.some((c: any[]) => c[1]?.symbol === 'SQ')).toBe(false);
  });

  it('a 200 (no security definition) streaming error triggers background resolution automatically', async () => {
    const s = session(); const socket = await connect(s);
    socket.reqContractDetails.mockImplementation((reqId: number) => {
      queueMicrotask(() => {
        socket.emit(EventName.contractDetails, reqId, { contract: { symbol: 'BRK B', conId: 5, primaryExch: 'NYSE' } });
        socket.emit(EventName.contractDetailsEnd, reqId);
      });
    });
    const tickerId = s.subscribeMarketData('BRK.B');
    socket.emit(EventName.error, new Error('No security definition has been found for the request'), 200, tickerId);
    // Background resolution is fire-and-forget - give microtasks a chance to settle.
    for (let n = 0; n < 10; n++) await Promise.resolve();

    expect(socket.reqContractDetails).toHaveBeenCalled();
  });
});
