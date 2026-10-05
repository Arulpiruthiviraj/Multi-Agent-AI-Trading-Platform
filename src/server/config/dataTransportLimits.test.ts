import { describe, it, expect } from 'vitest';
import { dataTransportLimits } from './dataTransportLimits';

/**
 * 2026-10-05 memory-investigation fix: the UI WebSocket fan-out previously had no
 * backpressure guard and no server-side keepalive, so a stalled/half-open client
 * accumulated an unbounded send buffer and a permanent EventBus wildcard subscription.
 * These config keys drive that fix - this test pins their presence and validity so a
 * missing key fails loudly at boot (the loader throws) rather than silently disabling
 * the guard.
 */
describe('dataTransportLimits WS backpressure/keepalive keys', () => {
  it('exposes positive-integer WS guardrails', () => {
    expect(dataTransportLimits.wsSendHighWaterBytes).toBe(1048576);
    expect(dataTransportLimits.wsKeepaliveIntervalMs).toBe(30000);
    expect(dataTransportLimits.wsCongestedIntervalsBeforeTerminate).toBe(4);
    for (const key of ['wsSendHighWaterBytes', 'wsKeepaliveIntervalMs', 'wsCongestedIntervalsBeforeTerminate'] as const) {
      expect(Number.isSafeInteger(dataTransportLimits[key])).toBe(true);
      expect(dataTransportLimits[key]).toBeGreaterThan(0);
    }
  });
});
