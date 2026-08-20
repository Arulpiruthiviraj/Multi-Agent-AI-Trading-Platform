import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAiModeHonesty,
  buildDecisionEvidenceRecord,
  DECISION_EVIDENCE_SCHEMA,
  enrichDecisionEvidenceWithOutcomes,
  summarizeDecisionEvidence,
} from './decisionEvidence';
import { evidenceFromPitIdeas, replayChiefTraderFromEvidence } from '../engines/backtest/PitReplay';
import { tradingSafety } from '../config/tradingSafety';
import { strengthToConfidence } from '../services/technicalSignal';
import { replaySafety } from './replaySafety';

const ROOT = join(__dirname, '../../..');

describe('decisionEvidence (historical prediction vs outcome)', () => {
  it('buildDecisionEvidenceRecord preserves votes/consensus floors without inventing outcomes', () => {
    const rec = buildDecisionEvidenceRecord({
      symbol: 'AAPL',
      timestamp: 1_700_000_000_000,
      strategyId: 'MOMENTUM_BREAKOUT',
      predictedSide: 'BUY',
      referencePrice: 100,
      agentVotes: [
        { agent: 'QuantEngine', side: 'BUY', confidence: 0.9, weight: 0.15 },
        { agent: 'TechnicalAgent', side: 'BUY', confidence: 0.8, weight: 0.25 },
      ],
      independentAgreeingAgents: 2,
      weightedConfidence: 0.8375,
      consensusApproved: true,
      consensusReason: 'approved',
      stageOutcome: 'ORDER_FILLED',
      rejectionGate: null,
      riskGates: [{ gateName: 'market_hours', sequence: 12, passed: true }],
      traceId: 'replay-test-1',
    });
    expect(rec.schema).toBe(DECISION_EVIDENCE_SCHEMA);
    expect(rec.consensusThreshold).toBe(tradingSafety.consensusApprovalThreshold);
    expect(rec.minIndependentAgreeingAgents).toBe(tradingSafety.minIndependentAgreeingAgents);
    expect(rec.forwardReturnPct).toBeNull();
    expect(rec.mfePct).toBeNull();
    expect(rec.maePct).toBeNull();
    expect(rec.label).toBe('DECISION_TIME_ONLY');
    expect(rec.agentVotes).toHaveLength(2);
    expect(rec.riskGates?.[0].gateName).toBe('market_hours');
  });

  it('enrichDecisionEvidenceWithOutcomes attaches MFE/MAE/forward return AFTER decision time only', () => {
    const t0 = Date.UTC(2024, 0, 2);
    const day = 86_400_000;
    const rec = buildDecisionEvidenceRecord({
      symbol: 'AAPL',
      timestamp: t0,
      strategyId: 'MOMENTUM_BREAKOUT',
      predictedSide: 'BUY',
      referencePrice: 100,
      agentVotes: [{ agent: 'QuantEngine', side: 'BUY', confidence: 0.9, weight: 0.15 }],
      independentAgreeingAgents: 1,
      weightedConfidence: 0.9,
      consensusApproved: false,
      consensusReason: 'NO_TRADE',
      stageOutcome: 'CONSENSUS_REJECTED',
    });
    const bars = new Map([
      ['AAPL', [
        { timestamp: t0, open: 100, high: 101, low: 99, close: 100, volume: 1e6 },
        { timestamp: t0 + day, open: 101, high: 110, low: 98, close: 105, volume: 1e6 },
        { timestamp: t0 + 2 * day, open: 105, high: 108, low: 97, close: 102, volume: 1e6 },
      ]],
    ]);
    const [enriched] = enrichDecisionEvidenceWithOutcomes([rec], bars as any, { horizonBars: 2 });
    expect(enriched.label).toBe('AFTER-THE-FACT ANALYSIS');
    expect(enriched.barsAvailableAfterDecision).toBe(2);
    expect(enriched.mfePct).toBeCloseTo(10, 4); // high 110
    expect(enriched.maePct).toBeCloseTo(-3, 4); // low 97
    expect(enriched.forwardReturnPct).toBeCloseTo(2, 4); // close 102
  });

  it('SELL predictions invert directional MFE/MAE (down is favorable)', () => {
    const t0 = Date.UTC(2024, 0, 2);
    const day = 86_400_000;
    const rec = buildDecisionEvidenceRecord({
      symbol: 'AAPL',
      timestamp: t0,
      strategyId: 'MOMENTUM_BREAKOUT',
      predictedSide: 'SELL',
      referencePrice: 100,
      agentVotes: [],
      independentAgreeingAgents: 0,
      weightedConfidence: 0,
      consensusApproved: false,
      consensusReason: 'x',
      stageOutcome: 'CONSENSUS_REJECTED',
    });
    const bars = new Map([
      ['AAPL', [
        { timestamp: t0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
        { timestamp: t0 + day, open: 99, high: 105, low: 90, close: 92, volume: 1 },
      ]],
    ]);
    const [enriched] = enrichDecisionEvidenceWithOutcomes([rec], bars as any, { horizonBars: 1 });
    // Favorable for SELL = downside to 90 → +10%; adverse = upside to 105 → -5%
    expect(enriched.mfePct).toBeCloseTo(10, 4);
    expect(enriched.maePct).toBeCloseTo(-5, 4);
  });

  it('summarizeDecisionEvidence counts stages without auto-tuning claims', () => {
    const a = buildDecisionEvidenceRecord({
      symbol: 'AAPL', timestamp: 1, strategyId: 'X', predictedSide: 'BUY', referencePrice: 1,
      agentVotes: [], independentAgreeingAgents: 0, weightedConfidence: 0,
      consensusApproved: false, consensusReason: 'r', stageOutcome: 'CONSENSUS_REJECTED',
    });
    const b = buildDecisionEvidenceRecord({
      symbol: 'AAPL', timestamp: 2, strategyId: 'X', predictedSide: 'BUY', referencePrice: 1,
      agentVotes: [], independentAgreeingAgents: 2, weightedConfidence: 0.8,
      consensusApproved: true, consensusReason: 'ok', stageOutcome: 'RISK_REJECTED',
    });
    const summary = summarizeDecisionEvidence([a, b]);
    expect(summary.count).toBe(2);
    expect(summary.byStageOutcome.CONSENSUS_REJECTED).toBe(1);
    expect(summary.byStageOutcome.RISK_REJECTED).toBe(1);
    expect(summary.note).toMatch(/Does not auto-tune/);
  });

  it('buildAiModeHonesty documents DISABLED cannot invent LLM votes and floors stay 0.75/2', () => {
    const h = buildAiModeHonesty('DISABLED');
    expect(h.llmVotesInvoked).toBe(false);
    expect(h.reason).toBe(replaySafety.aiModeHonestyDescription);
    expect(h.consensusImplication).toMatch(/≥2 independent/);
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
  });

  it('live-like TechnicalAgent confidence range can mathematically reach consensus 0.75 with Quant (no threshold lower)', () => {
    // strengthToConfidence maps [0,1] → [0.55, 0.95]. At tech=0.80 and quant=0.70:
    // (0.70*0.15 + 0.80*0.25) / 0.40 = (0.105 + 0.20) / 0.40 = 0.7625 >= 0.75
    const techConf = strengthToConfidence(0.625); // ≈ 0.80
    expect(techConf).toBeGreaterThanOrEqual(0.55);
    expect(techConf).toBeLessThanOrEqual(0.95);
    const ideas = [
      { kind: 'AGENT_REASONING', agent: 'QuantEngine', side: 'BUY', confidence: 0.70, publishedAtMs: 1 },
      { kind: 'AGENT_REASONING', agent: 'TechnicalAgent', side: 'BUY', confidence: techConf, publishedAtMs: 1 },
    ];
    const evidence = evidenceFromPitIdeas(ideas, 'AAPL', 100);
    const chief = replayChiefTraderFromEvidence(evidence, false);
    expect(chief.independentAgreeingAgents).toBe(2);
    expect(chief.confidence).toBeGreaterThanOrEqual(tradingSafety.consensusApprovalThreshold);
    expect(chief.approved).toBe(true);
  });

  it('QuantEngine alone under AI_DISABLED cannot approve (min 2 agents — fidelity, not a threshold change)', () => {
    const ideas = [
      { kind: 'AGENT_REASONING', agent: 'QuantEngine', side: 'BUY', confidence: 1.0, publishedAtMs: 1 },
    ];
    const chief = replayChiefTraderFromEvidence(evidenceFromPitIdeas(ideas, 'AAPL', 100), false);
    expect(chief.independentAgreeingAgents).toBe(1);
    expect(chief.approved).toBe(false);
    expect(chief.reason).toMatch(/agents 1\/2/);
  });

  it('enrichDecisionEvidenceWithOutcomes is not called from processTimestamp (architecture)', () => {
    const engine = readFileSync(join(ROOT, 'src/server/replay/FullArgusReplayEngine.ts'), 'utf8');
    const processIdx = engine.indexOf('async function processTimestamp');
    expect(processIdx).toBeGreaterThan(0);
    const processBody = engine.slice(processIdx, processIdx + 14000);
    expect(processBody).not.toContain('enrichDecisionEvidenceWithOutcomes(');
    expect(engine).toContain('decision_evidence.json');
    expect(engine).toContain('buildAiModeHonesty');
  });
});
