import { describe, it, expect } from 'vitest';
import { evaluatePitAiBuyGate, replayChiefTraderFromEvidence } from './PitReplay';
import { tradingSafety } from '../../config/tradingSafety';

describe('PIT AI buy gate', () => {
  it('does not treat an empty ledger as AI-approved technical BUY', () => {
    const gate = evaluatePitAiBuyGate([], 'AAPL', 100);
    expect(gate.ledgerPresent).toBe(false);
    expect(gate.allowBuy).toBe(false);
    expect(gate.replay?.approved).toBe(false);
    expect(gate.replay?.reason).toMatch(/PIT ledger empty/);
  });

  it('can allow technical-only strategy backtests when explicitly opted in', () => {
    const gate = evaluatePitAiBuyGate([], 'AAPL', 100, { allowTechnicalWhenEmpty: true });
    expect(gate.ledgerPresent).toBe(false);
    expect(gate.allowBuy).toBe(true);
    expect(gate.replay?.approved).toBe(false);
  });

  it('replays EvidenceAggregator math and approves a two-agent BUY above the live threshold', () => {
    const gate = evaluatePitAiBuyGate([
      { kind: 'AGENT_REASONING', agent: 'TechnicalAgent', side: 'BUY', confidence: 0.9, publishedAtMs: 1 },
      { kind: 'NEWS_AGENT', agent: 'NewsAgent', side: 'BUY', confidence: 0.9, publishedAtMs: 2 },
    ], 'AAPL', 100);
    expect(gate.ledgerPresent).toBe(true);
    expect(gate.allowBuy).toBe(true);
    expect(gate.replay?.debateReplayed).toBe(false);
    expect(gate.replay?.side).toBe('BUY');
    expect(gate.replay?.approved).toBe(true);
    expect(gate.replay!.confidence).toBeGreaterThanOrEqual(tradingSafety.consensusApprovalThreshold);
    expect(gate.replay!.independentAgreeingAgents).toBeGreaterThanOrEqual(tradingSafety.minIndependentAgreeingAgents);
  });

  it('blocks a BUY when PIT agents do not meet min independent voters', () => {
    const gate = evaluatePitAiBuyGate([
      { kind: 'AGENT_REASONING', agent: 'TechnicalAgent', side: 'BUY', confidence: 0.99, publishedAtMs: 1 },
    ], 'AAPL', 100);
    expect(gate.ledgerPresent).toBe(true);
    expect(gate.allowBuy).toBe(false);
    expect(gate.replay?.approved).toBe(false);
  });

  it('uses a stored ChiefTrader row without replaying debate', () => {
    const blocked = evaluatePitAiBuyGate([
      { kind: 'CHIEF_TRADER', agent: 'ChiefTrader', side: 'HOLD', confidence: 0.9, publishedAtMs: 5 },
    ], 'AAPL', 100);
    expect(blocked.allowBuy).toBe(false);
    expect(blocked.replay?.debateReplayed).toBe(false);

    const allowed = evaluatePitAiBuyGate([
      { kind: 'CHIEF_TRADER', agent: 'ChiefTrader', side: 'BUY', confidence: tradingSafety.consensusApprovalThreshold, publishedAtMs: 5 },
    ], 'AAPL', 100);
    expect(allowed.allowBuy).toBe(true);
  });
});

describe('replayChiefTraderFromEvidence', () => {
  it('does not claim debate was replayed', () => {
    const replay = replayChiefTraderFromEvidence([]);
    expect(replay.debateReplayed).toBe(false);
    expect(replay.approved).toBe(false);
  });
});
