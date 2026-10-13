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
    reqHistoricalData = vi.fn(); cancelHistoricalData = vi.fn();
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
afterEach(async () => { for (const s of sessions.splice(0)) await s.disconnect(); sockets.length = 0; });

describe('IbkrSocketSession historical-data error observability (2026-09-20 remediation, part B)', () => {
  it('a reqHistoricalData rejection fires the dedicated historical-data error handler with requestType-distinguishing detail, distinct from the streaming path', async () => {
    const s = session(); const socket = await connect(s);
    const historicalErrors: any[] = [];
    const historicalTimings: any[] = [];
    const streamingErrors: any[] = [];
    s.setHistoricalDataErrorHandler((detail) => historicalErrors.push(detail));
    s.setHistoricalDataTimingHandler((detail) => historicalTimings.push(detail));
    s.setMarketDataErrorHandler((symbol, code, message) => streamingErrors.push({ symbol, code, message }));

    socket.reqHistoricalData.mockImplementation((reqId: number) => {
      queueMicrotask(() => socket.emit(EventName.error, new Error('No security definition has been found for the request'), 200, reqId));
    });

    await expect(s.requestHistoricalBars('SQ', '1Day', Date.now() - 86_400_000, Date.now())).rejects.toThrow(/historicalData error code=200/);

    expect(historicalErrors).toHaveLength(1);
    expect(historicalErrors[0]).toMatchObject({ symbol: 'SQ', code: 200 });
    expect(historicalErrors[0].durationStr).toEqual(expect.any(String));
    expect(historicalErrors[0].barSize).toEqual(expect.any(String));
    expect(historicalErrors[0].whatToShow).toEqual(expect.any(String));
    expect(typeof historicalErrors[0].reqId).toBe('number');

    // A historical-request error must never be mistaken for (or double-counted as) a streaming
    // reqMktData rejection - the two observability paths are fully independent.
    expect(streamingErrors).toHaveLength(0);
    expect(historicalTimings).toHaveLength(1);
    expect(historicalTimings[0]).toMatchObject({ symbol: 'SQ', timeframe: '1Day', outcome: 'ERROR', barCount: 0 });
    expect(historicalTimings[0].queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(historicalTimings[0].serviceMs).toBeGreaterThanOrEqual(0);
    expect(historicalTimings[0].totalMs).toBeGreaterThanOrEqual(historicalTimings[0].serviceMs);
  });

  it('a successful historical request never fires the error handler', async () => {
    const s = session(); const socket = await connect(s);
    const historicalErrors: any[] = [];
    s.setHistoricalDataErrorHandler((detail) => historicalErrors.push(detail));

    socket.reqHistoricalData.mockImplementation((reqId: number) => {
      queueMicrotask(() => socket.emit(EventName.historicalData, reqId, 'finished', 0, 0, 0, 0, 0));
    });

    await expect(s.requestHistoricalBars('SPY', '1Day', Date.now() - 86_400_000, Date.now())).resolves.toEqual([]);
    expect(historicalErrors).toHaveLength(0);
  });

  it('measures histChain queue wait separately from IBKR service time', async () => {
    const s = session(); const socket = await connect(s);
    const timings: any[] = [];
    s.setHistoricalDataTimingHandler((detail) => timings.push(detail));
    let calls = 0;
    socket.reqHistoricalData.mockImplementation((reqId: number) => {
      calls += 1;
      if (calls === 1) {
        setTimeout(() => socket.emit(EventName.historicalData, reqId, 'finished', 0, 0, 0, 0, 0), 30);
      } else {
        queueMicrotask(() => socket.emit(EventName.historicalData, reqId, 'finished', 0, 0, 0, 0, 0));
      }
    });

    const now = Date.now();
    const first = s.requestHistoricalBars('SPY', '1Min', now - 60_000, now);
    const second = s.requestHistoricalBars('QQQ', '1Min', now - 60_000, now);
    await Promise.all([first, second]);

    expect(timings).toHaveLength(2);
    expect(timings[0]).toMatchObject({ symbol: 'SPY', outcome: 'EMPTY' });
    expect(timings[1]).toMatchObject({ symbol: 'QQQ', outcome: 'EMPTY' });
    expect(timings[1].queueWaitMs).toBeGreaterThanOrEqual(20);
    expect(timings[1].totalMs).toBeGreaterThanOrEqual(timings[1].queueWaitMs);
  });
});
