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
    reqMarketDataType = vi.fn();
  }
  return { ...actual, IBApi: Socket };
});
import { IbkrSocketSession } from '../IbkrSocketSession';
import { isIbkrDelayedDataResearchEnabled } from '../IbkrSocketSession';

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

const originalEnv = process.env.IBKR_DELAYED_DATA_RESEARCH_ENABLED;
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.disconnect();
  sockets.length = 0;
  if (originalEnv === undefined) delete process.env.IBKR_DELAYED_DATA_RESEARCH_ENABLED;
  else process.env.IBKR_DELAYED_DATA_RESEARCH_ENABLED = originalEnv;
});

describe('isIbkrDelayedDataResearchEnabled() (2026-09-29 delayed-data research feed)', () => {
  it('is false when unset - the real default, zero behavior change', () => {
    delete process.env.IBKR_DELAYED_DATA_RESEARCH_ENABLED;
    expect(isIbkrDelayedDataResearchEnabled()).toBe(false);
  });

  it('is false for any value other than the exact string "true" - no fuzzy truthiness', () => {
    expect(isIbkrDelayedDataResearchEnabled({ IBKR_DELAYED_DATA_RESEARCH_ENABLED: 'TRUE' } as any)).toBe(false);
    expect(isIbkrDelayedDataResearchEnabled({ IBKR_DELAYED_DATA_RESEARCH_ENABLED: '1' } as any)).toBe(false);
    expect(isIbkrDelayedDataResearchEnabled({ IBKR_DELAYED_DATA_RESEARCH_ENABLED: 'yes' } as any)).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    expect(isIbkrDelayedDataResearchEnabled({ IBKR_DELAYED_DATA_RESEARCH_ENABLED: 'true' } as any)).toBe(true);
  });
});

describe('IbkrSocketSession reqMarketDataType(3) gating (2026-09-29 delayed-data research feed)', () => {
  it('default (flag unset): never calls reqMarketDataType - byte-for-byte current connect() behavior preserved', async () => {
    delete process.env.IBKR_DELAYED_DATA_RESEARCH_ENABLED;
    const s = session();
    const socket = await connect(s);
    expect(socket.reqMarketDataType).not.toHaveBeenCalled();
  });

  it('flag explicitly false: never calls reqMarketDataType', async () => {
    process.env.IBKR_DELAYED_DATA_RESEARCH_ENABLED = 'false';
    const s = session();
    const socket = await connect(s);
    expect(socket.reqMarketDataType).not.toHaveBeenCalled();
  });

  it('flag=true: calls reqMarketDataType(3) exactly once per connect, after the existing reqIds/reqCurrentTime/reqManagedAccts calls', async () => {
    process.env.IBKR_DELAYED_DATA_RESEARCH_ENABLED = 'true';
    const s = session();
    const socket = await connect(s);
    expect(socket.reqMarketDataType).toHaveBeenCalledTimes(1);
    expect(socket.reqMarketDataType).toHaveBeenCalledWith(3);
    expect(socket.reqIds).toHaveBeenCalled();
    expect(socket.reqManagedAccts).toHaveBeenCalled();
  });

  it('a throwing reqMarketDataType() does not fail the connection - the connect handshake must not depend on this optional call succeeding', async () => {
    process.env.IBKR_DELAYED_DATA_RESEARCH_ENABLED = 'true';
    const s = session();
    const before = sockets.length;
    const pending = s.connect();
    for (let n = 0; sockets.length === before && n < 20; n++) await Promise.resolve();
    const socket = sockets.at(-1);
    socket.reqMarketDataType = vi.fn(() => { throw new Error('simulated IB rejection'); });
    socket.emit('connected');
    socket.emit('managedAccounts', 'DU123456');
    await expect(pending).resolves.toBe(true);
  });
});
