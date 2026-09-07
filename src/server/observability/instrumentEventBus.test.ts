import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Real gap found (2026-09-06/07 post-audit remediation, ARGUS_CURRENT_STATE_AND_PAPER_READINESS_AUDIT.md
 * §21 P2 finding): installObservabilityEventBridge()'s generic wildcard bridge extracted a fixed,
 * trade-idea-shaped field set (symbol/side/status/gate/approved/agent/confidence/orderId/stage) for
 * EVERY event type. AI_PROVIDERS_EXHAUSTED's real payload (agentType/lastError/providersAttempted)
 * matched none of those names, so every extracted field came back undefined and JSON.stringify
 * silently dropped them all - the persisted observability_events row's payload column was a real,
 * confirmed `{}` for an event whose in-memory eventBus payload was never actually empty.
 */
const { enqueueObservabilityEvent } = vi.hoisted(() => ({ enqueueObservabilityEvent: vi.fn() }));
vi.mock('./ObservabilityStore', () => ({ enqueueObservabilityEvent }));

import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { installObservabilityEventBridge, resetObservabilityBridgeForTests } from './instrumentEventBus';

describe('instrumentEventBus - generic wildcard bridge', () => {
  beforeEach(() => {
    enqueueObservabilityEvent.mockClear();
    resetObservabilityBridgeForTests();
    installObservabilityEventBridge();
  });

  it('persists a real, non-empty payload for AI_PROVIDERS_EXHAUSTED instead of the previous {}', () => {
    eventBus.publish(EVENTS.AI_PROVIDERS_EXHAUSTED, {
      agentType: 'FundamentalAgent',
      providersAttempted: ['gemini', 'openai'],
      lastError: 'All providers timed out',
    });

    expect(enqueueObservabilityEvent).toHaveBeenCalled();
    const row = enqueueObservabilityEvent.mock.calls[0][0];
    expect(row.eventType).toBe(EVENTS.AI_PROVIDERS_EXHAUSTED);
    expect(row.payload).not.toBeNull();
    expect(row.payload).not.toBe('{}');
    expect(row.payload).not.toBe('{"payload":{}}');
    const parsed = JSON.parse(row.payload).payload;
    expect(parsed.agentType).toBe('FundamentalAgent');
    expect(parsed.lastError).toBe('All providers timed out');
    expect(parsed.providersAttempted).toEqual(['gemini', 'openai']);
  });

  it('still persists real fields for a trade-idea-shaped event (no regression to the existing extraction)', () => {
    eventBus.publish(EVENTS.TRADE_IDEA_REJECTED, {
      reason: 'MISSING_PRICE',
      symbol: 'AAPL',
      agent: 'NewsAgent',
    });

    expect(enqueueObservabilityEvent).toHaveBeenCalled();
    const row = enqueueObservabilityEvent.mock.calls[0][0];
    expect(row.symbol).toBe('AAPL');
    const parsed = JSON.parse(row.payload).payload;
    expect(parsed.agent).toBe('NewsAgent');
  });
});
