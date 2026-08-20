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
});
