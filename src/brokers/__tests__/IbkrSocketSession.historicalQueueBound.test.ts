import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadIbkrConnection } from '../../server/config/ibkrConnection';
import { continuousIntelligence } from '../../server/config/continuousIntelligence';

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
afterEach(async () => { vi.useRealTimers(); for (const s of sessions.splice(0)) await s.disconnect(); sockets.length = 0; });

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('IBKR historical chain is bounded (2026-10-13)', () => {
  it('rejects immediately once ibkrHistoricalMaxQueuedRequests are already waiting, with a DROPPED_QUEUE_FULL timing record', async () => {
    const s = session(); const socket = await connect(s);
    const timings: any[] = [];
    s.setHistoricalDataTimingHandler((d) => timings.push(d));
    const max = continuousIntelligence.ibkrHistoricalMaxQueuedRequests;
    const now = Date.now();
    // first request occupies the chain (never answered); `max` more wait behind it
    const settled: Promise<unknown>[] = [];
    const caught = (p: Promise<unknown>) => { const q = p.then(() => 'ok', (e) => String(e)); settled.push(q); return q; };
    caught(s.requestHistoricalBars('AAA', '1Day', now - 86_400_000, now));
    await flush();
    for (let i = 0; i < max; i++) caught(s.requestHistoricalBars(`B${i}`, '1Day', now - 86_400_000, now));
    await flush();
    expect(socket.reqHistoricalData).toHaveBeenCalledTimes(1);
    const overflow = await s.requestHistoricalBars('OVERFLOW', '1Min', now - 3_600_000, now).then(() => 'ok', (e) => String(e));
    expect(overflow).toMatch(/IBKR_HISTORICAL_QUEUE_FULL/);
    expect(timings.find((t) => t.symbol === 'OVERFLOW')).toMatchObject({ outcome: 'DROPPED_QUEUE_FULL', queueDepthAtEnqueue: max });
    expect(socket.reqHistoricalData).toHaveBeenCalledTimes(1); // nothing extra was sent to the provider
  });

  it('an INTRADAY request that waited past ibkrIntradayHistoricalMaxQueueWaitMs is dropped unserved; a daily request is not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T14:00:00Z'));
    const s = session(); const socket = await connect(s);
    const timings: any[] = [];
    s.setHistoricalDataTimingHandler((d) => timings.push(d));
    const now = Date.now();
    const first = s.requestHistoricalBars('AAA', '1Day', now - 86_400_000, now).then(() => 'ok', (e) => String(e));
    await flush();
    const intraday = s.requestHistoricalBars('BBB', '1Min', now - 3_600_000, now).then(() => 'ok', (e) => String(e));
    const daily = s.requestHistoricalBars('CCC', '1Day', now - 86_400_000, now).then(() => 'ok', (e) => String(e));
    await flush();
    vi.setSystemTime(Date.now() + continuousIntelligence.ibkrIntradayHistoricalMaxQueueWaitMs + 1_000);
    // answer AAA (finish) so the chain advances
    const firstReq = socket.reqHistoricalData.mock.calls[0][0];
    socket.emit(EventName.historicalData, firstReq, 'finished', 0, 0, 0, 0, 0);
    await first;
    expect(await intraday).toMatch(/IBKR_HISTORICAL_QUEUE_STALE/);
    expect(timings.find((t) => t.symbol === 'BBB')).toMatchObject({ outcome: 'DROPPED_QUEUE_STALE', serviceMs: 0 });
    // daily CCC is serviced (reqHistoricalData invoked for it), not dropped by age
    await flush();
    expect(socket.reqHistoricalData.mock.calls.map((c: any[]) => c[1]?.symbol ?? c[1])).toBeDefined();
    expect(socket.reqHistoricalData).toHaveBeenCalledTimes(2); // AAA + CCC; BBB never reached the provider
    const cccReq = socket.reqHistoricalData.mock.calls[1][0];
    socket.emit(EventName.historicalData, cccReq, 'finished', 0, 0, 0, 0, 0);
    expect(await daily).toBe('ok');
  });
});
