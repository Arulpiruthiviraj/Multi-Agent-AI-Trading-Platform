import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../core/EventBus';
import { continuousIntelligence } from '../config/continuousIntelligence';
import {
  canEmitPortfolioExitIdea,
  noteExitEmission,
  resetPortfolioIntelForTests,
  releaseExitCooldownAfterRejection,
} from './portfolioIntel';

/**
 * 2026-10-13 S protective exit: rejected at 09:14 (premarket spread), retried only at 09:19 because the exit-idea
 * cooldown ignored the rejection. A RiskEngine REJECTION leaves nothing pending at the broker, so the retry window is
 * short; an approved/filled/pending exit keeps the full cooldown (no duplicate exit orders).
 */
describe('protective exit retry after a RiskEngine rejection', () => {
  const cd = () => continuousIntelligence.exitIdeaCooldownMs;
  const retry = () => continuousIntelligence.exitIdeaRejectedRetryMs;
  const t0 = 1_800_000_000_000;
  const original = process.env.ARGUS_PORTFOLIO_INTEL_ENABLED;
  beforeEach(() => { process.env.ARGUS_PORTFOLIO_INTEL_ENABLED = 'true'; resetPortfolioIntelForTests(); });
  afterEach(() => { if (original === undefined) delete process.env.ARGUS_PORTFOLIO_INTEL_ENABLED; else process.env.ARGUS_PORTFOLIO_INTEL_ENABLED = original; });

  it('config: the rejected-exit retry is shorter than the full cooldown and not zero', () => {
    expect(retry()).toBeGreaterThan(0);
    expect(retry()).toBeLessThan(cd());
  });

  it('without a rejection the full cooldown still blocks a second exit idea (unchanged behavior)', () => {
    expect(canEmitPortfolioExitIdea('S', t0)).toBe(true);
    expect(canEmitPortfolioExitIdea('S', t0 + retry() + 1)).toBe(false);
    expect(canEmitPortfolioExitIdea('S', t0 + cd() + 1)).toBe(true);
  });

  it('a RiskEngine rejection of THIS exit trace releases the symbol after exitIdeaRejectedRetryMs, not the full cooldown', () => {
    expect(canEmitPortfolioExitIdea('S', t0)).toBe(true);
    noteExitEmission('S', 'trace-exit-1');
    eventBus.emitRiskAssessment({ traceId: 'trace-exit-1', symbol: 'S', side: 'SELL', approved: false, reasoning: 'extended_hours_execution_policy' });
    const now = Date.now();
    // Immediately after the rejection it is still held back (never an instant retry loop) ...
    expect(canEmitPortfolioExitIdea('S', now)).toBe(false);
    // ... and allowed once the short retry window has passed, well before the 5-minute cooldown.
    expect(canEmitPortfolioExitIdea('S', now + retry() + 1)).toBe(true);
  });

  it('an APPROVED exit, another symbol, another trace, or a BUY never shortens the cooldown', () => {
    expect(canEmitPortfolioExitIdea('S', t0)).toBe(true);
    noteExitEmission('S', 'trace-exit-2');
    eventBus.emitRiskAssessment({ traceId: 'trace-exit-2', symbol: 'S', side: 'SELL', approved: true, reasoning: 'ok' });
    eventBus.emitRiskAssessment({ traceId: 'other-trace', symbol: 'S', side: 'SELL', approved: false, reasoning: 'x' });
    eventBus.emitRiskAssessment({ traceId: 'trace-exit-2', symbol: 'S', side: 'BUY', approved: false, reasoning: 'x' });
    eventBus.emitRiskAssessment({ traceId: 'trace-exit-2', symbol: 'AAPL', side: 'SELL', approved: false, reasoning: 'x' });
    expect(canEmitPortfolioExitIdea('S', Date.now() + retry() + 1)).toBe(false);
  });

  it('releaseExitCooldownAfterRejection is a no-op for a symbol that never emitted', () => {
    expect(() => releaseExitCooldownAfterRejection('NEVER')).not.toThrow();
    expect(canEmitPortfolioExitIdea('NEVER', t0)).toBe(true);
  });
});
