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

describe('IBKR historical requests are intent-prioritized and bounded (2026-10-13)', () => {
  it('rejects immediately once the class queue bound is reached, with a DROPPED_QUEUE_FULL timing record, and sends nothing extra to the provider', async () => {
    const s = session(); const socket = await connect(s);
    const timings: any[] = [];
    s.setHistoricalDataTimingHandler((d) => timings.push(d));
    const max = continuousIntelligence.ibkrHistMaxQueuedP2;
    const now = Date.now();
    const pending: Promise<unknown>[] = [];
    pending.push(s.requestHistoricalBars('AAA', '1Day', now - 86_400_000, now).catch(() => 'x')); // undeclared intent + current window -> RECENT_CACHE_REFRESH (P2)
    await flush();
    for (let i = 0; i < max; i++) pending.push(s.requestHistoricalBars(`B${i}`, '1Day', now - 86_400_000, now).catch(() => 'x'));
    await flush();
    expect(socket.reqHistoricalData).toHaveBeenCalledTimes(1);
    const overflow = await s.requestHistoricalBars('OVERFLOW', '1Day', now - 86_400_000, now).then(() => 'ok', (e) => String(e));
    expect(overflow).toMatch(/IBKR_HISTORICAL_QUEUE_FULL/);
    expect(timings.find((t) => t.symbol === 'OVERFLOW')).toMatchObject({ outcome: 'DROPPED_QUEUE_FULL', queueDepthAtEnqueue: max, priority: 2 });
    expect(socket.reqHistoricalData).toHaveBeenCalledTimes(1);
    expect(s.getHistoricalQueueStats().depthByPriority[2]).toBe(max);
  });

  it('a live-session request (declared intent) is served BEFORE queued older-window research requests, and the old windows are classified as backfill', async () => {
    const s = session(); const socket = await connect(s);
    const timings: any[] = [];
    s.setHistoricalDataTimingHandler((d) => timings.push(d));
    const now = Date.now();
    const weeksAgo = now - 21 * 86_400_000;
    // first request occupies the wire; two weeks-old research windows queue behind it
    const first = s.requestHistoricalBars('HOLD', '1Min', now - 3_600_000, now).catch(() => 'x');
    await flush();
    const old1 = s.requestHistoricalBars('OLDA', '1Min', weeksAgo, weeksAgo + 3_600_000).catch(() => 'x');
    const old2 = s.requestHistoricalBars('OLDB', '1Min', weeksAgo, weeksAgo + 3_600_000).catch(() => 'x');
    const { runWithHistoricalIntent } = await import('../../server/data/historicalRequestIntent');
    const live = runWithHistoricalIntent('QUANT_ON_DEMAND', () => s.requestHistoricalBars('SPY', '1Min', now - 3_600_000, now)).catch(() => 'x');
    await flush();
    // answer HOLD
    const reqOf = (n: number) => socket.reqHistoricalData.mock.calls[n][0];
    socket.emit(EventName.historicalData, reqOf(0), 'finished', 0, 0, 0, 0, 0);
    await first; await flush();
    // the next request on the wire is the live SPY one, not OLDA
    const sentSymbols = socket.reqHistoricalData.mock.calls.map((c: any[]) => c[1]?.symbol);
    expect(sentSymbols.slice(0, 2)).toEqual(['HOLD', 'SPY']);
    socket.emit(EventName.historicalData, reqOf(1), 'finished', 0, 0, 0, 0, 0);
    await live; await flush();
    expect(socket.reqHistoricalData.mock.calls.map((c: any[]) => c[1]?.symbol)[2]).toBe('OLDA');
    expect(timings.find((t) => t.symbol === 'SPY')).toMatchObject({ intent: 'QUANT_ON_DEMAND', priority: 1 });
    void old1; void old2;
  });

  it('timing records carry intent, priority and coalesced waiter count', async () => {
    const s = session(); const socket = await connect(s);
    const timings: any[] = [];
    s.setHistoricalDataTimingHandler((d) => timings.push(d));
    const now = Date.now();
    const { runWithHistoricalIntent } = await import('../../server/data/historicalRequestIntent');
    const a = runWithHistoricalIntent('QUANT_SCHEDULED', () => s.requestHistoricalBars('DUP', '1Min', now - 3_600_000, now));
    const b = runWithHistoricalIntent('QUANT_ON_DEMAND', () => s.requestHistoricalBars('DUP', '1Min', now - 3_600_000, now + 5_000));
    await flush();
    expect(socket.reqHistoricalData).toHaveBeenCalledTimes(1); // coalesced: one provider request
    socket.emit(EventName.historicalData, socket.reqHistoricalData.mock.calls[0][0], 'finished', 0, 0, 0, 0, 0);
    await Promise.all([a, b]); await flush();
    expect(timings.find((t) => t.symbol === 'DUP')).toMatchObject({ coalescedWaiters: 1, priority: 1 });
  });
});
