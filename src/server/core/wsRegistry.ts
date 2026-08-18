/**
 * Shared WebSocketServer handle so route modules can read client counts without importing server.ts.
 */
import type { WebSocketServer } from 'ws';

let globalWss: WebSocketServer | null = null;

export function setGlobalWss(w: WebSocketServer): void {
  globalWss = w;
}

export function getGlobalWss(): WebSocketServer | null {
  return globalWss;
}

export function getWsClientCount(): number {
  return globalWss?.clients.size ?? 0;
}
