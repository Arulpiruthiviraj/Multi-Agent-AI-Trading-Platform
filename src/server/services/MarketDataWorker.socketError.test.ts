import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 2026-10-12 (M3): the socket 'error' handler must call tearDownSocket() BEFORE
 * scheduleReconnect('socket error'), mirroring the 'close' handler's order. A mock `ws`
 * WebSocket lets the real handler order be asserted deterministically without a live
 * Alpaca connection (same mock pattern as MarketDataWorker.test.ts).
 */
const { MockWebSocket, instances } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = 1;
    listeners: Record<string, Function[]> = {};
    sentMessages: any[] = [];
    on(event: string, cb: Function) {
      (this.listeners[event] ||= []).push(cb);
    }
    removeAllListeners() {
      this.listeners = {};
    }
    send(data: string) {
      this.sentMessages.push(JSON.parse(data));
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
    }
    emit(event: string, ...args: any[]) {
      (this.listeners[event] || []).forEach(cb => cb(...args));
    }
  }
  const instances: MockWebSocket[] = [];
  return { MockWebSocket, instances };
});

vi.mock('ws', () => ({
  default: class {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    constructor() {
      const instance = new MockWebSocket();
      instances.push(instance);
      return instance;
    }
  },
}));

const { emitSpy } = vi.hoisted(() => ({
  emitSpy: vi.fn(),
}));
vi.mock('../core/EventBus', () => ({
  eventBus: { emitMarketData: vi.fn(), emit: emitSpy, subscribe: vi.fn() },
}));
vi.mock('../core/ideaGenerationGate', () => ({
  isLiveIdeaGenerationEnabled: () => true,
  isAutobotTradingEnabled: () => true,
}));

import { MarketDataWorker } from './MarketDataWorker';

describe('MarketDataWorker socket error path (2026-10-12 M3)', () => {
  let worker: MarketDataWorker;

  beforeEach(() => {
    instances.length = 0;
    emitSpy.mockClear();
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';
    worker = new MarketDataWorker();
    worker.start();
  });

  afterEach(() => {
    worker.stop(); // clears the reconnect timer the error path schedules
    vi.restoreAllMocks();
  });

  it("tears down the errored socket BEFORE scheduling the reconnect (mirrors the 'close' handler)", () => {
    const socket: any = instances[0];
    expect(socket).toBeDefined();

    const tearDownSpy = vi.spyOn(worker as any, 'tearDownSocket');
    const scheduleSpy = vi.spyOn(worker as any, 'scheduleReconnect');

    socket.emit('error', new Error('simulated socket error'));

    expect(tearDownSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith('socket error');
    // Ordering: the teardown ran before the reconnect was scheduled.
    expect(tearDownSpy.mock.invocationCallOrder[0])
      .toBeLessThan(scheduleSpy.mock.invocationCallOrder[0]);
    // The dead socket is closed and detached, exactly like the close handler leaves it:
    // this.ws nulled (so the socket's own late 'close' is ignored), not authenticated.
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
    expect((worker as any).ws).toBeNull();
    expect((worker as any).authenticated).toBe(false);
  });

  it("a late 'close' from the already-torn-down socket does not schedule a second reconnect", () => {
    const socket: any = instances[0];
    const scheduleSpy = vi.spyOn(worker as any, 'scheduleReconnect');

    socket.emit('error', new Error('simulated socket error'));
    expect(scheduleSpy).toHaveBeenCalledTimes(1);

    // The errored socket's own close arriving late must be ignored: tearDownSocket()
    // already nulled this.ws, so the close handler's `this.ws !== socket` guard returns.
    // (Listeners were removed by the teardown, so this emit is a no-op either way.)
    socket.emit('close');
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });
});
