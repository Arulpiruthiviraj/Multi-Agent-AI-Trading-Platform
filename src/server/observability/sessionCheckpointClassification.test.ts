import { describe, it, expect } from 'vitest';
import { classifySessionCheckpoint, type SessionCheckpointInput } from './sessionCheckpointClassification';

const input = (overrides: Partial<SessionCheckpointInput> = {}): SessionCheckpointInput => ({
  tradingState: 'TRADING_ENABLED', autobotEnabled: true, brokerDown: false,
  marketSession: 'RTH', marketDataReady: true, symbolsDiscovered: 10,
  subscriptionsActive: 10, subscriptionsFresh: 10, quantAssessments: 100,
  quantValidationFailed: 0, strategyTriggers: 0, quantIdeas: 10,
  consensusRoundsStarted: 100, consensusRejected: 100, quantApprovals: 0,
  riskEvaluations: 0, riskApproved: 0, ordersSubmitted: 0, fills: 0,
  topTerminalReasons: [{ code: 'CONFIDENCE_BELOW_STRONG', count: 100 }],
  aiAvailability: 'AI_UNAVAILABLE', aiHealthyProviders: 0, aiTotalProviders: 5,
  quantAvailability: 'QUANT_HEALTHY', observabilityQueuePending: 0,
  observabilityQueueDropped: 0, reconciliationMatch: true,
  quantPolicyEnabled: true, authorizedPaperQuantStrategies: 0, quantPolicyEvaluations: 0,
  ...overrides,
});

describe('read-only session checkpoint blockers', () => {
  it('identifies the real zero-authority, zero-policy-evaluation bottleneck despite healthy workers', () => {
    const result = classifySessionCheckpoint(input());
    expect(result.verdict).toBe('SUSPICIOUS_ZERO_TRADE');
    expect(result.blockers).toEqual(['QUANT_PATH_UNREACHABLE']);
    expect(result.reasons.join(' ')).toContain('authorization gap');
  });
  it('does not invent a quant blockage when authorized strategies abstain on merit', () => {
    const result = classifySessionCheckpoint(input({ authorizedPaperQuantStrategies: 1 }));
    expect(result.verdict).toBe('HEALTHY_ZERO_TRADE');
    expect(result.blockers).toEqual([]);
  });
  it('does not confuse evaluated-but-rejected policy with unreachable policy', () => {
    expect(classifySessionCheckpoint(input({ quantPolicyEvaluations: 3 })).blockers).toEqual([]);
  });
  it('does not require the quant path when its policy is disabled', () => {
    expect(classifySessionCheckpoint(input({ quantPolicyEnabled: false })).blockers).toEqual([]);
  });
  it('does not flag dormant quant before any assessment', () => {
    expect(classifySessionCheckpoint(input({ quantAssessments: 0 })).blockers).toEqual([]);
  });
  it('discloses unknown evidence rather than manufacturing a zero count', () => {
    const result = classifySessionCheckpoint(input({ quantPolicyEvaluations: undefined }));
    expect(result.blockers).toEqual([]);
    expect(result.reasons.join(' ')).toContain('reachability is UNKNOWN');
    expect(result.verdict).toBe('INCONCLUSIVE_ZERO_TRADE');
  });
  it('surfaces a pending mismatch while trading remains enabled', () => {
    const result = classifySessionCheckpoint(input({ authorizedPaperQuantStrategies: 1, reconciliationMatch: false }));
    expect(result.verdict).toBe('SUSPICIOUS_ZERO_TRADE');
    expect(result.blockers).toEqual(['RECONCILIATION_MISMATCH']);
  });
  it('preserves legacy reporting when callers lack new evidence', () => {
    const result = classifySessionCheckpoint(input({ quantPolicyEnabled: undefined }));
    expect(result.verdict).toBe('HEALTHY_ZERO_TRADE');
    expect(result.blockers).toEqual([]);
  });
  it('keeps real fill activity distinct from an inactive quant subpath', () => {
    const result = classifySessionCheckpoint(input({ fills: 1 }));
    expect(result.verdict).toBe('TRADING');
    expect(result.blockers).toContain('QUANT_PATH_UNREACHABLE');
  });
  it.each(['quantApprovals', 'riskApproved', 'ordersSubmitted'] as const)(
    'does not claim execution from %s alone', (stage) => {
      const result = classifySessionCheckpoint(input({ [stage]: 1 }));
      expect(result.verdict).toBe('PIPELINE_PROGRESS_NO_FILL');
      expect(result.blockers).toContain('QUANT_PATH_UNREACHABLE');
      expect(result.reasons.join(' ')).toContain('do not prove execution');
    },
  );
  it('does not infer authority when its read fails', () => {
    expect(classifySessionCheckpoint(input({ authorizedPaperQuantStrategies: undefined })).verdict)
      .toBe('INCONCLUSIVE_ZERO_TRADE');
  });
});
