/**
 * Real (not mocked) http + WebSocketServer pair, mirroring server.ts's exact wildcard-forwarding
 * pattern against the real EventBus singleton. Proves the invariant Section 6 of the engine-
 * hardening spec asked for: browser/WS clients connecting and disconnecting - one at a time, or
 * many at once - never leaks listeners and never touches trading state. This does not boot the
 * full Argus core (heavy, ~60s elsewhere in this repo) - it only needs the real EventBus and the
 * real `ws` package, which is exactly what server.ts's own connection handler depends on too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { eventBus } from './EventBus';

function once(target: WebSocket, event: string): Promise<void> {
  return new Promise((resolve) => target.once(event, () => resolve()));
}

describe('WS client connect/disconnect never affects trading state or leaks EventBus listeners', () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let port: number;
  let baselineListenerCount: number;
  let serverSideConnectionCount = 0;
  let serverSideCloseCount = 0;

  /** Mirrors server.ts's real ws.on('connection'/'close') wildcard-forwarding pattern exactly. */
  function attachServerLikeHandler(): void {
    wss.on('connection', (ws) => {
      const wildcardHandler = (eventName: string, payload: any) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: eventName, data: payload }));
        }
      };
      eventBus.on('*', wildcardHandler);
      serverSideConnectionCount += 1;
      ws.on('close', () => {
        eventBus.off('*', wildcardHandler);
        serverSideCloseCount += 1;
      });
    });
  }

  /** eventBus.on()/off() run synchronously inside the server's own 'connection'/'close' handlers,
   * so waiting for the SERVER to report N connections/closes (not the client's own 'open'/'close'
   * events, which can resolve a tick before the server side has run on a loopback connection) is
   * the correct signal that the listener registration/cleanup has actually happened. */
  async function waitForCondition(check: () => boolean, label: string): Promise<void> {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > 5000) throw new Error(`Timed out waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  const waitForServerConnections = (n: number) => waitForCondition(() => serverSideConnectionCount >= n, `${n} server-side connections`);
  const waitForServerCloses = (n: number) => waitForCondition(() => serverSideCloseCount >= n, `${n} server-side closes`);

  beforeEach(async () => {
    baselineListenerCount = eventBus.listenerCount('*');
    serverSideConnectionCount = 0;
    serverSideCloseCount = 0;
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer });
    attachServerLikeHandler();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as any).port;
  });

  afterEach(async () => {
    // Force-terminate any clients left open by a failed assertion, so the server can actually
    // close instead of waiting forever for connections that will never close on their own.
    wss.clients.forEach((c) => c.terminate());
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 15000);

  it('a single client connecting then disconnecting returns the listener count to baseline', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(client, 'open');
    await waitForServerConnections(1);
    expect(eventBus.listenerCount('*')).toBe(baselineListenerCount + 1);

    client.close();
    await once(client, 'close');
    await waitForServerCloses(1);
    expect(eventBus.listenerCount('*')).toBe(baselineListenerCount);
  });

  it('multiple clients connecting then all disconnecting at once returns the listener count to baseline', async () => {
    const clients = [new WebSocket(`ws://127.0.0.1:${port}`), new WebSocket(`ws://127.0.0.1:${port}`), new WebSocket(`ws://127.0.0.1:${port}`)];
    await Promise.all(clients.map((c) => once(c, 'open')));
    await waitForServerConnections(3);
    expect(eventBus.listenerCount('*')).toBe(baselineListenerCount + 3);

    clients.forEach((c) => c.close());
    await Promise.all(clients.map((c) => once(c, 'close')));
    await waitForServerCloses(3);
    expect(eventBus.listenerCount('*')).toBe(baselineListenerCount);
  });

  it('emitting a real EventBus event while a client is connected does not throw and reaches the client', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(client, 'open');
    await waitForServerConnections(1);

    const received = new Promise<any>((resolve) => {
      client.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    });
    expect(() => eventBus.emit('*', 'TEST_EVENT', { hello: 'world' })).not.toThrow();
    const msg = await received;
    expect(msg).toEqual({ type: 'TEST_EVENT', data: { hello: 'world' } });

    client.close();
    await once(client, 'close');
  });

  it('a disconnected client never receives further events (no lingering handler)', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(client, 'open');
    await waitForServerConnections(1);
    client.close();
    await once(client, 'close');

    let receivedAfterClose = false;
    client.on('message', () => { receivedAfterClose = true; });
    eventBus.emit('*', 'TEST_EVENT_AFTER_CLOSE', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(receivedAfterClose).toBe(false);
  });
});
