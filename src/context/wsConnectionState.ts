/**
 * Pure reconnect/heartbeat state-machine logic for WebSocketContext.tsx, extracted so it is
 * unit-testable without a React/jsdom harness (this repo's vitest config runs `environment: 'node'`
 * over `.test.ts` only - no React Testing Library setup exists yet, see CLAUDE.md's own "App.tsx
 * almost untested" note). WebSocketContext.tsx is a thin wrapper around these functions; behavior
 * here must stay identical to what it replaced (same exponential backoff, same 12s hard heartbeat
 * timeout) - only the explicit 'reconnecting'/'stale' states are new (Phase 3B).
 */

export type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'stale' | 'disconnected';

/** Socket open but no PONG in this long is surfaced as STALE (soft warning) - connection is kept alive. */
export const WS_STALE_AFTER_MS = 6000;
/** No PONG in this long forces a reconnect (hard timeout) - unchanged from the pre-3B behavior. */
export const WS_HEARTBEAT_TIMEOUT_MS = 12000;
/** Reconnect backoff ceiling - unchanged from the pre-3B behavior. */
export const WS_MAX_BACKOFF_MS = 30000;

/** 1s, 2s, 4s, 8s, ... capped at WS_MAX_BACKOFF_MS. Same formula as the original inline code. */
export function computeReconnectDelayMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, Math.max(0, attempt)), WS_MAX_BACKOFF_MS);
}

/** Soft warning threshold - connection is still open, just late on a heartbeat reply. */
export function isHeartbeatStale(lastPongAt: number, now: number): boolean {
  return now - lastPongAt > WS_STALE_AFTER_MS;
}

/** Hard threshold - caller should close and let the reconnect path take over. */
export function isHeartbeatTimedOut(lastPongAt: number, now: number): boolean {
  return now - lastPongAt > WS_HEARTBEAT_TIMEOUT_MS;
}

/** Status to show while a connect() attempt is in flight - distinguishes first-ever connect from a retry. */
export function initialConnectStatus(hasConnectedOnce: boolean): WsConnectionStatus {
  return hasConnectedOnce ? 'reconnecting' : 'connecting';
}

/** Status once the socket closes. A reconnect is only actually scheduled when enabled && !disposed. */
export function nextStatusOnClose(opts: { disposed: boolean; enabled: boolean }): WsConnectionStatus {
  if (opts.disposed || !opts.enabled) return 'disconnected';
  return 'reconnecting';
}
