import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingEngine } from '../engines/TradingEngine';
import { considerScreenerTick, resetOpportunityScreenerForTests } from './OpportunityScreener';
import { getRecentCandidates, resetRecentCandidatesForTests } from '../core/recentCandidateRegistry';
import { resetCandidatesForTests, getCandidate } from './candidateLifecycle';

const FLAG = continuousIntelligence.opportunityIdeasEnabledEnvVar;

describe('OpportunityScreener - considerScreenerTick', () => {
  beforeEach(() => {
    resetOpportunityScreenerForTests();
    resetRecentCandidatesForTests();
    resetCandidatesForTests();
    process.env[FLAG] = 'true';
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
  });

  afterEach(() => {
    delete process.env[FLAG];
    resetOpportunityScreenerForTests();
    resetRecentCandidatesForTests();
    resetCandidatesForTests();
  });

  function feedRisingTicks(symbol: string, startPrice: number, returnPct: number, bars: number) {
    let result;
    for (let i = 0; i < bars; i++) {
      const price = startPrice * (1 + (returnPct * i) / (bars - 1));
      result = considerScreenerTick({ symbol, price });
    }
    return result!;
  }

  it('does nothing (FLAG_OFF) when ARGUS_OPPORTUNITY_IDEAS_ENABLED is not true', () => {
    delete process.env[FLAG];
    const result = considerScreenerTick({ symbol: 'AAPL', price: 100 });
    expect(result).toEqual({ emitted: false, reason: 'FLAG_OFF', symbol: 'AAPL' });
  });

  it('warms up (no emission, no candidate registration) until enough bars accumulate', () => {
    const bars = continuousIntelligence.screenerMinHistoryBars;
    const result = considerScreenerTick({ symbol: 'MSFT', price: 100 });
    expect(result.reason).toBe('WARMUP');
    expect(getCandidate('MSFT')?.state).toBe('WATCHING');
    expect(getRecentCandidates(300000)).not.toContain('MSFT');
    expect(bars).toBeGreaterThan(1); // sanity - this test assumes more than 1 bar is required
  });

  it('a real qualifying momentum candidate emits a vote, marks PROMOTED, and registers into recentCandidateRegistry', () => {
    const ideas: any[] = [];
    const onIdea = (p: any) => ideas.push(p);
    eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);

    const bars = continuousIntelligence.screenerMinHistoryBars;
    const minReturn = continuousIntelligence.screenerMinReturnPct;
    const result = feedRisingTicks('NVDA', 100, minReturn * 2, bars);

    eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);

    expect(result.reason).toBe('EMITTED');
    const idea = ideas.find((i) => i.symbol === 'NVDA');
    expect(idea).toBeDefined();
    expect(idea.agent).toBe('OpportunityScreener');
    expect(idea.side).toBe('BUY');

    expect(getCandidate('NVDA')?.state).toBe('PROMOTED');
    // Phase 9 (same-candidate convergence): the real screened candidate also reaches the
    // registry Fundamental/MacroAgent's priority round-robin consults.
    expect(getRecentCandidates(300000)).toContain('NVDA');
  });

  it('does NOT register a candidate when the real return stays below the threshold', () => {
    const bars = continuousIntelligence.screenerMinHistoryBars;
    const minReturn = continuousIntelligence.screenerMinReturnPct;
    const result = feedRisingTicks('SPY', 100, minReturn * 0.1, bars);

    expect(result.reason).toBe('RETURN_BELOW_THRESHOLD');
    expect(getRecentCandidates(300000)).not.toContain('SPY');
  });
});
