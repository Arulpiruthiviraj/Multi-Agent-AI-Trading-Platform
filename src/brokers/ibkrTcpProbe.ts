/**
 * Lightweight TCP reachability probe for IB Gateway / TWS socket ports.
 * Does not speak the IB API — only answers "is something accepting connections".
 */
import net from 'net';

export function probeTcpPort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

export async function findFirstOpenTcpPort(
  host: string,
  ports: number[],
  timeoutMs = 1500,
): Promise<number | null> {
  for (const port of ports) {
    if (await probeTcpPort(host, port, timeoutMs)) return port;
  }
  return null;
}
