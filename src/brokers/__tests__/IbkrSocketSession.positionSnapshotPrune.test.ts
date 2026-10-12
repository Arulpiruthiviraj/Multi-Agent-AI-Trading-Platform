import { describe, it, expect, vi } from 'vitest';

vi.mock('../ibkrTcpProbe', () => ({ findFirstOpenTcpPort: vi.fn(async () => 4002) }));

type Handlers = Record<string, ((...args: any[]) => void)[]>;
let lastFakeIb: any = null;
vi.mock('@stoqey/ib', async () => {
  const actual = await vi.importActual<typeof import('@stoqey/ib')>('@stoqey/ib');
  class FakeIBApi {
    constructor() {
      const handlers: Handlers = {};
      const fake: any = {
        on(e: string, h: (...a: any[]) => void) { (handlers[e] ||= []).push(h); return fake; },
        emit(e: string, ...a: any[]) { for (const h of handlers[e] || []) h(...a); },
        connect: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn(), reqIds: vi.fn(), reqCurrentTime: vi.fn(),
        reqManagedAccts: vi.fn(), reqAccountSummary: vi.fn(), reqPositions: vi.fn(), reqOpenOrders: vi.fn(),
        reqExecutions: vi.fn(), placeOrder: vi.fn(), cancelOrder: vi.fn(),
      };
      lastFakeIb = fake;
      return fake;
    }
  }
  return { ...actual, IBApi: FakeIBApi };
});

async function connected() {
  const { IbkrSocketSession } = await import('../IbkrSocketSession');
  const session: any = new IbkrSocketSession();
  lastFakeIb = null;
  const p = session.connect(false);
  for (let i = 0; i < 20 && !lastFakeIb; i++) await new Promise((r) => setImmediate(r));
  lastFakeIb.emit('connected');
  lastFakeIb.emit('nextValidId', 100);
  lastFakeIb.emit('managedAccounts', 'DU1234567');
  expect(await p).toBe(true);
  return session;
}

describe('IbkrSocketSession position snapshot pruning (2026-10-12 stale DDOG position)', () => {
  it('drops a position the broker no longer reports once the next snapshot completes', async () => {
    const session = await connected();
    lastFakeIb.emit('position', 'DU1234567', { symbol: 'DDOG' }, 10, 280);
    lastFakeIb.emit('position', 'DU1234567', { symbol: 'S' }, 38, 25.8);
    lastFakeIb.emit('positionEnd');
    expect(session.getPositionsSnapshot().map((p: any) => p.symbol).sort()).toEqual(['DDOG', 'S']);

    // DDOG fully exited: the next snapshot lists only S and sends NO zero-quantity DDOG event.
    lastFakeIb.emit('position', 'DU1234567', { symbol: 'S' }, 38, 25.8);
    lastFakeIb.emit('positionEnd');
    expect(session.getPositionsSnapshot().map((p: any) => p.symbol)).toEqual(['S']);
  });

  it('keeps positions that are still reported, and an empty snapshot clears everything', async () => {
    const session = await connected();
    lastFakeIb.emit('position', 'DU1234567', { symbol: 'S' }, 38, 25.8);
    lastFakeIb.emit('positionEnd');
    lastFakeIb.emit('position', 'DU1234567', { symbol: 'S' }, 38, 25.8);
    lastFakeIb.emit('positionEnd');
    expect(session.getPositionsSnapshot()).toHaveLength(1);
    lastFakeIb.emit('positionEnd');
    expect(session.getPositionsSnapshot()).toHaveLength(0);
  });
});
