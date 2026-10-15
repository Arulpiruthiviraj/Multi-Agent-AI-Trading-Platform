import { describe, it, expect, afterEach } from 'vitest';
import {
  allowAiCall,
  allowTradeIdea,
  getPipelineRateSnapshot,
  resetPipelineRateLimitForTests,
} from './pipelineRateLimit';
import { tradingSafety } from '../config/tradingSafety';

afterEach(() => {
  resetPipelineRateLimitForTests();
});

describe('pipelineRateLimit', () => {
  it('caps ideas per minute without lowering consensus', () => {
    const cap = tradingSafety.maxTradeIdeasPerMinute;
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < cap + 40; i++) {
      if (allowTradeIdea(1_700_000_000_000)) allowed += 1;
      else denied += 1;
    }
    expect(allowed).toBe(cap);
    expect(denied).toBe(40);
    expect(getPipelineRateSnapshot(1_700_000_000_000).ideasDropped).toBe(40);
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
  });

  it('caps AI calls per minute fail-closed', () => {
    const cap = tradingSafety.maxAiCallsPerMinute;
    let allowed = 0;
    for (let i = 0; i < cap + 10; i++) {
      if (allowAiCall(1_700_000_000_000)) allowed += 1;
    }
    expect(allowed).toBe(cap);
    expect(getPipelineRateSnapshot(1_700_000_000_000).aiDropped).toBe(10);
  });

  it('a protective exit neither consumes nor is denied by a saturated window (2026-10-15: 28-33% of ideas were being dropped)', () => {
    const cap = tradingSafety.maxTradeIdeasPerMinute;
    const now = 1_700_000_000_000;
    for (let i = 0; i < cap; i++) expect(allowTradeIdea(now, { agent: 'KronosEngine' })).toBe(true);
    expect(allowTradeIdea(now, { agent: 'TechnicalAgent' })).toBe(false); // saturated for research votes
    expect(allowTradeIdea(now, { agent: 'PortfolioManager', protectiveExit: true })).toBe(true);
    expect(allowTradeIdea(now, { agent: 'PortfolioManager', protectiveExit: true })).toBe(true);
    const snap = getPipelineRateSnapshot(now);
    expect(snap.ideasInWindow).toBe(cap); // exits did not consume capacity
    expect(snap.protectiveExitsExempted).toBe(2);
    expect(snap.ideasDropped).toBe(1);
    expect(snap.ideasDroppedByAgent).toEqual({ TechnicalAgent: 1 });
  });

  it('drops are attributed per agent with bounded keys, and an unnamed emitter is UNKNOWN', () => {
    const cap = tradingSafety.maxTradeIdeasPerMinute;
    const now = 1_700_000_000_000;
    for (let i = 0; i < cap; i++) allowTradeIdea(now, { agent: 'A' });
    for (let i = 0; i < 3; i++) allowTradeIdea(now, { agent: 'KronosEngine' });
    allowTradeIdea(now);
    for (let i = 0; i < 200; i++) allowTradeIdea(now, { agent: 'spam-' + i });
    const by = getPipelineRateSnapshot(now).ideasDroppedByAgent;
    expect(by.KronosEngine).toBe(3);
    expect(by.UNKNOWN).toBe(1);
    expect(Object.keys(by).length).toBeLessThanOrEqual(64);
  });
});
