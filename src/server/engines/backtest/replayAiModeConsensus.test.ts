/**
 * Unit tests for replay aiMode consensus wiring.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveReplayAiModeConsensus,
  mergeLiveConsensusDebateVote,
} from './replayAiModeConsensus';
import { tradingSafety } from '../../config/tradingSafety';

describe('resolveReplayAiModeConsensus', () => {
  const baseIdeas = [
    { kind: 'AGENT_REASONING', agent: 'QuantEngine', side: 'BUY', confidence: 0.8, publishedAtMs: 1 },
    { kind: 'AGENT_REASONING', agent: 'TechnicalAgent', side: 'BUY', confidence: 0.8, publishedAtMs: 1 },
  ];

  it('DISABLED uses Quant+Technical and can clear 0.75 with two agents', () => {
    const r = resolveReplayAiModeConsensus({
      aiMode: 'DISABLED',
      symbol: 'AAPL',
      currentPrice: 100,
      asOfMs: 1,
      baseIdeas,
    });
    expect(r.ledgerUsed).toBe(false);
    expect(r.consensus?.approved).toBe(true);
    expect(r.consensus!.confidence).toBeGreaterThanOrEqual(tradingSafety.consensusApprovalThreshold);
  });

  it('RECORDED with empty ledger falls back to DISABLED path without inventing LLM votes', () => {
    const r = resolveReplayAiModeConsensus({
      aiMode: 'RECORDED_DECISION_REPLAY',
      symbol: 'AAPL',
      currentPrice: 100,
      asOfMs: 1,
      baseIdeas,
      recordedIdeas: [],
    });
    expect(r.ledgerUsed).toBe(false);
    expect(r.reason).toMatch(/empty/);
    expect(r.ideas).toEqual(baseIdeas);
  });

  it('LIVE_MODEL merge fail-closed keeps floors intact', () => {
    const base = resolveReplayAiModeConsensus({
      aiMode: 'LIVE_MODEL_REPLAY',
      symbol: 'AAPL',
      currentPrice: 100,
      asOfMs: 1,
      baseIdeas,
    });
    const merged = mergeLiveConsensusDebateVote(base, null, 'AAPL', 100);
    expect(merged.liveModelInvoked).toBe(true);
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
  });
});
