import { describe, it, expect } from 'vitest';
import {
  computeReconnectDelayMs,
  isHeartbeatStale,
  isHeartbeatTimedOut,
  initialConnectStatus,
  nextStatusOnClose,
  WS_STALE_AFTER_MS,
  WS_HEARTBEAT_TIMEOUT_MS,
  WS_MAX_BACKOFF_MS,
} from './wsConnectionState';

describe('computeReconnectDelayMs', () => {
  it('doubles starting from 1000ms', () => {
    expect(computeReconnectDelayMs(0)).toBe(1000);
    expect(computeReconnectDelayMs(1)).toBe(2000);
    expect(computeReconnectDelayMs(2)).toBe(4000);
    expect(computeReconnectDelayMs(3)).toBe(8000);
    expect(computeReconnectDelayMs(4)).toBe(16000);
  });

  it('caps at WS_MAX_BACKOFF_MS for large attempt counts', () => {
    expect(computeReconnectDelayMs(5)).toBe(WS_MAX_BACKOFF_MS);
    expect(computeReconnectDelayMs(20)).toBe(WS_MAX_BACKOFF_MS);
  });

  it('never returns less than the base delay for a negative/invalid attempt', () => {
    expect(computeReconnectDelayMs(-3)).toBe(1000);
  });
});

describe('isHeartbeatStale / isHeartbeatTimedOut', () => {
  it('is not stale exactly at the boundary or before it', () => {
    expect(isHeartbeatStale(1000, 1000 + WS_STALE_AFTER_MS)).toBe(false);
    expect(isHeartbeatStale(1000, 1000 + WS_STALE_AFTER_MS - 1)).toBe(false);
  });

  it('is stale just past the boundary', () => {
    expect(isHeartbeatStale(1000, 1000 + WS_STALE_AFTER_MS + 1)).toBe(true);
  });

  it('is not timed out before the hard threshold', () => {
    expect(isHeartbeatTimedOut(1000, 1000 + WS_HEARTBEAT_TIMEOUT_MS)).toBe(false);
  });

  it('is timed out just past the hard threshold', () => {
    expect(isHeartbeatTimedOut(1000, 1000 + WS_HEARTBEAT_TIMEOUT_MS + 1)).toBe(true);
  });

  it('stale threshold is strictly shorter than the hard timeout (stale must warn before the forced reconnect)', () => {
    expect(WS_STALE_AFTER_MS).toBeLessThan(WS_HEARTBEAT_TIMEOUT_MS);
  });
});

describe('initialConnectStatus', () => {
  it('reports connecting for the very first attempt', () => {
    expect(initialConnectStatus(false)).toBe('connecting');
  });

  it('reports reconnecting once the client has connected at least once before', () => {
    expect(initialConnectStatus(true)).toBe('reconnecting');
  });
});

describe('nextStatusOnClose', () => {
  it('reports disconnected (terminal) when disposed', () => {
    expect(nextStatusOnClose({ disposed: true, enabled: true })).toBe('disconnected');
  });

  it('reports disconnected (terminal) when the caller explicitly disabled the connection', () => {
    expect(nextStatusOnClose({ disposed: false, enabled: false })).toBe('disconnected');
  });

  it('reports reconnecting when a retry is actually going to be scheduled', () => {
    expect(nextStatusOnClose({ disposed: false, enabled: true })).toBe('reconnecting');
  });
});
