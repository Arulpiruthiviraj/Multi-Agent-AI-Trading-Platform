import { describe, it, expect, vi } from 'vitest';
import { SyntheticSessionEngine } from './SyntheticSessionEngine';
import { eventBus } from '../../core/EventBus';
import { getActiveReplaySession } from '../ReplayContext';
import { HistoricalReplayBroker } from '../../../brokers/HistoricalReplayBroker';

/**
 * Per-session teardown regression (2026-10-08 memory-leak hunt).
 *
 * Runs back-to-back SyntheticSessionEngine sessions in ONE process - the same core loop as
 * scripts/soak/threeHourSoakChild.ts - and proves every per-session structure has a teardown:
 *
 *  1. DecisionTimeline's EventBus listeners are unsubscribed after every session (success AND
 *     mid-run failure). A missed unsubscribe leaks 19 listeners per failed iteration and, via
 *     the bound handlers, retains the whole engine/session.
 *  2. The installed ActiveReplaySession is cleared after every session (no cross-session
 *     retention of the broker / barsBySymbol / timeline).
 *  3. Post-gc heap slope across sessions is flat (multi-session heap-slope; only asserted when
 *     the process exposes global.gc, i.e. NODE_OPTIONS=--expose-gc - otherwise skipped, the
 *     teardown assertions above still run).
 *
 * Synthetic-only, isolated DB via prepareIsolatedEnvironment(); PAPER/SIMULATION only.
 * Does not change replay semantics - it only observes teardown.
 */

// The exact event types DecisionTimeline subscribes per session (see its TRACKED_EVENTS).
const TRACKED_EVENTS = [
  'MARKET_DATA', 'TRADE_IDEA_GENERATED', 'TRADE_IDEA_REJECTED', 'IDEA_RATE_LIMITED',
  'CHIEF_CONSENSUS_STARTED', 'CHIEF_CONSENSUS_COMPLETED', 'TRADE_REJECTED_CONSENSUS', 'CHIEF_APPROVED_IDEA',
  'RISK_ASSESSMENT_STARTED', 'RISK_ASSESSMENT_COMPLETED', 'RISK_BLOCK', 'RISK_GATE_EVALUATED',
  'ORDER_SUBMITTED', 'ORDER_ACCEPTED', 'ORDER_FILLED', 'ORDER_EXECUTED',
  'DESK_NO_TRADE', 'CANDIDATE_REJECTED', 'ASSET_CANDIDATE_BLOCKED',
];

function listenerCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of TRACKED_EVENTS) out[e] = eventBus.listenerCount(e);
  return out;
}

const HEAP_SLOPE_BOUND_MB = 5; // generous: probe measured ~0.17 MB/session; catches real leaks

describe('SyntheticSessionEngine - per-session teardown across back-to-back sessions', () => {
  it('unsubscribes timeline listeners, clears the active session, and keeps heap flat', async () => {
    const simId = `teardown-test-${Date.now()}`;
    const sessionOpts = {
      simulationId: simId,
      scenarioId: 'QUIET_OPEN',
      seed: 4242,
      speedMultiplier: 30,
      sessionDurationMinutes: 12,
      universeSize: 3,
      initialCash: 100_000,
    } as const;

    const gcAvailable = typeof (global as any).gc === 'function';
    const gc = () => { (global as any).gc?.(); };
    const heapMb = () => process.memoryUsage().heapUsed / 1048576;

    const postGcHeaps: number[] = [];

    // Session 0: warmup. Absorbs the one-time bootArgusCore() cost - boot registers the
    // production singleton listeners (idea agents, ChiefTrader, RiskEngine observers, ...),
    // which is expected one-time behavior, not a per-session leak. The per-session baseline
    // is taken AFTER boot so the assertions below measure only session setup/teardown.
    {
      const engine = new SyntheticSessionEngine();
      engine.prepareIsolatedEnvironment({ simulationId: simId, scenarioId: 'QUIET_OPEN', seed: 4242 });
      await engine.run({ ...sessionOpts });
      expect(getActiveReplaySession()).toBeNull();
    }
    const baseline = listenerCounts();

    // Session 1: success-path teardown proof.
    {
      const engine = new SyntheticSessionEngine();
      engine.prepareIsolatedEnvironment({ simulationId: simId, scenarioId: 'QUIET_OPEN', seed: 4242 });
      await engine.run({ ...sessionOpts });
      expect(getActiveReplaySession()).toBeNull();
      expect(listenerCounts()).toEqual(baseline);
      gc(); postGcHeaps.push(heapMb());
    }

    // Session 2: injected MID-RUN failure (after timeline.start(), inside the bar loop).
    // The try/finally teardown must still unsubscribe + clear the session.
    {
      const engine = new SyntheticSessionEngine();
      engine.prepareIsolatedEnvironment({ simulationId: simId, scenarioId: 'QUIET_OPEN', seed: 4242 });
      const spy = vi
        .spyOn(HistoricalReplayBroker.prototype, 'advanceWorkingOrders')
        .mockImplementationOnce(() => { throw new Error('injected mid-run failure'); });
      await expect(engine.run({ ...sessionOpts })).rejects.toThrow('injected mid-run failure');
      spy.mockRestore();
      expect(getActiveReplaySession()).toBeNull();
      expect(listenerCounts()).toEqual(baseline);
      gc(); postGcHeaps.push(heapMb());
    }

    // Sessions 3-4: back on the success path; heap slope measured across all post-gc points.
    for (let i = 0; i < 2; i++) {
      const engine = new SyntheticSessionEngine();
      engine.prepareIsolatedEnvironment({ simulationId: simId, scenarioId: 'QUIET_OPEN', seed: 4242 });
      await engine.run({ ...sessionOpts });
      expect(getActiveReplaySession()).toBeNull();
      expect(listenerCounts()).toEqual(baseline);
      gc(); postGcHeaps.push(heapMb());
    }

    if (!gcAvailable) {
      console.log('[teardown-test] global.gc unavailable (run with NODE_OPTIONS=--expose-gc) - heap-slope assertion skipped; teardown assertions still ran');
      return;
    }
    const first = postGcHeaps[0];
    const last = postGcHeaps[postGcHeaps.length - 1];
    const max = Math.max(...postGcHeaps);
    console.log(`[teardown-test] post-gc heaps (MB): ${postGcHeaps.map((h) => h.toFixed(2)).join(', ')}`);
    expect(max - first).toBeLessThan(HEAP_SLOPE_BOUND_MB);
    expect(last - first).toBeLessThan(HEAP_SLOPE_BOUND_MB);
  }, 300_000);
});
