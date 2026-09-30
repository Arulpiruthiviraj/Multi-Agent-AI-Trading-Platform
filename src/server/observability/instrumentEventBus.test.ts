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
  it('retains the failure state, state transition and reason code needed for a zero-idea audit', () => {
    eventBus.publish(EVENTS.RECONCILIATION_WARMUP, { reason: 'broker_not_ready', syncState: 'FAILED' });
    eventBus.publish(EVENTS.TRADING_STATE_CHANGED, { fromState: 'TRADING_PAUSED', toState: 'TRADING_ENABLED', reason: 'operator' });
    eventBus.publish(EVENTS.DESK_NO_TRADE, { symbol: 'AAPL', code: 'IDEA_GENERATION_GATED', reason: 'entry hold' });
    const payloadFor = (type: string) => JSON.parse(enqueueObservabilityEvent.mock.calls.find(([r]) => r.eventType === type)![0].payload).payload;
    expect(payloadFor(EVENTS.RECONCILIATION_WARMUP)).toMatchObject({ syncState: 'FAILED' });
    expect(payloadFor(EVENTS.TRADING_STATE_CHANGED)).toMatchObject({ fromState: 'TRADING_PAUSED', toState: 'TRADING_ENABLED' });
    expect(payloadFor(EVENTS.DESK_NO_TRADE)).toMatchObject({ code: 'IDEA_GENERATION_GATED' });
  });
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

  // 2026-09-10 real fix (postmarket-audit follow-up): NewsEngine.ts's NEWS_ANALYZED event uses
  // `symbols` (plural array), not `symbol` - confirmed live, the real cause of the SEI case
  // (a genuinely analyzed article never surfacing in any symbol-indexed query since its
  // observability_events row's symbol column was silently null).
  it('populates the symbol column from a plural symbols array when no singular symbol field exists (NEWS_ANALYZED shape)', () => {
    eventBus.publish(EVENTS.NEWS_ANALYZED, {
      id: 'article-1',
      clusterId: 'cluster-1',
      symbols: ['SEI', 'XLE'],
      impact: { impactScore: 70 },
      credibility: 0.9,
      category: 'EARNINGS',
    });

    expect(enqueueObservabilityEvent).toHaveBeenCalled();
    const row = enqueueObservabilityEvent.mock.calls[0][0];
    expect(row.symbol).toBe('SEI'); // first entry in the array - documented, honest limitation
    const parsed = JSON.parse(row.payload).payload;
    expect(parsed.symbol).toBe('SEI');
  });

  it('leaves the symbol column null (never fabricated) when an event has neither symbol nor symbols', () => {
    eventBus.publish(EVENTS.NEWS_PIPELINE_TICK, { telemetryPulse: true, fetched: 3, analyzed: 2 });

    expect(enqueueObservabilityEvent).toHaveBeenCalled();
    const row = enqueueObservabilityEvent.mock.calls[0][0];
    expect(row.symbol == null).toBe(true);
  });

  // 2026-09-16 real fix (universe/subscription starvation investigation, third confirmed instance
  // of this same fixed-whitelist gap): WATCHLIST_SUBSCRIBE_REQUESTED's real payload
  // (OpportunityDiscovery.ts) carries `reason`/`source`/`momentumScore` - none of which were in the
  // extraction whitelist, so all 5,126 real rows logged today persisted with only `{symbol}`,
  // silently dropping the exact field (`reason: 'BROAD_UNIVERSE_TOPUP'`) this investigation needed
  // to measure whether the new broad-universe subscription top-up fix was actually firing.
  it('persists reason/source/momentumScore for WATCHLIST_SUBSCRIBE_REQUESTED instead of silently dropping them to {symbol} only', () => {
    eventBus.publish(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, {
      symbol: 'AMZN',
      source: 'OpportunityDiscovery',
      reason: 'BROAD_UNIVERSE_TOPUP',
      momentumScore: undefined,
      honesty: 'Subscribe request only — not a trade idea and not an order.',
    });

    expect(enqueueObservabilityEvent).toHaveBeenCalled();
    const row = enqueueObservabilityEvent.mock.calls[0][0];
    expect(row.symbol).toBe('AMZN');
    const parsed = JSON.parse(row.payload).payload;
    expect(parsed.reason).toBe('BROAD_UNIVERSE_TOPUP');
    expect(parsed.source).toBe('OpportunityDiscovery');
  });

  // 2026-09-30 real fix (ARGUS_FULL_SESSION_REVIEW_2026-09-29.md follow-up, fourth confirmed
  // instance of this same fixed-whitelist gap): MARKET_DATA_GAP_DETECTED's real payload
  // (MarketDataWorker.ts, emitted on real Alpaca WebSocket re-authentication) carries
  // gapMs/disconnectedAt/reconnectedAt - none of which were in the extraction whitelist, so every
  // one of the 117 real rows persisted that day collapsed to `{}`, silently destroying the exact
  // field (gapMs) needed to measure real outage duration for the 93 regular-session
  // MARKET_DATA_DISCONNECTED events the September 29 full-session audit could not otherwise attribute.
  it('persists gapMs/disconnectedAt/reconnectedAt for MARKET_DATA_GAP_DETECTED instead of silently collapsing to {}', () => {
    eventBus.publish(EVENTS.MARKET_DATA_GAP_DETECTED, {
      gapMs: 1281,
      disconnectedAt: 1790685058374,
      reconnectedAt: 1790685059655,
    });

    expect(enqueueObservabilityEvent).toHaveBeenCalled();
    const row = enqueueObservabilityEvent.mock.calls[0][0];
    expect(row.payload).not.toBe('{"payload":{}}');
    const parsed = JSON.parse(row.payload).payload;
    expect(parsed.gapMs).toBe(1281);
    expect(parsed.disconnectedAt).toBe(1790685058374);
    expect(parsed.reconnectedAt).toBe(1790685059655);
  });
});
