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
import { IbkrSocketSession, ibkrHistoricalDuration } from '../IbkrSocketSession';
import { resetIbkrContractResolutionCacheForTests } from '../ibkrContractResolution';
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
afterEach(async () => { for (const s of sessions.splice(0)) await s.disconnect(); sockets.length = 0; resetIbkrContractResolutionCacheForTests(); });

describe('ibkrHistoricalDuration (2026-10-13: 1Min requests were padded to a 30-day minimum)', () => {
  const now = Date.UTC(2026, 9, 13, 15, 0, 0);
  it("1Day behavior is unchanged: 30 D minimum, 365 D cap, 2 Y beyond", () => {
    expect(ibkrHistoricalDuration('1Day', now - 3 * 86_400_000, now, now)).toBe('30 D');
    expect(ibkrHistoricalDuration('1Day', now - 100 * 86_400_000, now, now)).toBe('100 D');
    expect(ibkrHistoricalDuration('1Day', now - 400 * 86_400_000, now, now)).toBe('2 Y');
  });
  it("a 1Min request for today's session asks for seconds, not 30 days", () => {
    const open = Date.UTC(2026, 9, 13, 13, 30, 0);
    const d = ibkrHistoricalDuration('1Min', open, now, now);
    expect(d).toMatch(/^\d+ S$/);
    expect(parseInt(d, 10)).toBeLessThanOrEqual(86_400);
    expect(parseInt(d, 10)).toBeGreaterThanOrEqual(5_400); // covers the 90-minute window
  });
  it('the duration reaches back from NOW to the window start, so a window that ended earlier is still reachable', () => {
    const start = now - 3 * 3_600_000;
    const end = now - 2 * 3_600_000; // ended an hour... two hours ago
    const d = ibkrHistoricalDuration('1Min', start, end, now);
    expect(parseInt(d, 10)).toBeGreaterThanOrEqual(3 * 3600); // must cover now-3h, not just the 1h span
  });
  it('multi-day intraday requests use whole days without the 30-day minimum', () => {
    expect(ibkrHistoricalDuration('1Min', now - 2.2 * 86_400_000, now, now)).toBe('3 D');
  });
});

describe('IBKR code-200 negative cache (2026-10-13: malformed news-derived names)', () => {
  it('a code-200 historical rejection makes the next request for that string fail fast without a second IBKR request', async () => {
    const s = session(); const socket = await connect(s);
    socket.reqHistoricalData.mockImplementation((reqId: number) => {
      queueMicrotask(() => socket.emit(EventName.error, new Error('No security definition has been found for the request'), 200, reqId));
    });
    await expect(s.requestHistoricalBars('INTEL', '1Min', Date.now() - 3_600_000, Date.now())).rejects.toThrow(/code=200/);
    expect(socket.reqHistoricalData).toHaveBeenCalledTimes(1);
    await expect(s.requestHistoricalBars('INTEL', '1Min', Date.now() - 3_600_000, Date.now())).rejects.toThrow();
    expect(socket.reqHistoricalData).toHaveBeenCalledTimes(1); // no second round trip through the serial queue
  });
});
