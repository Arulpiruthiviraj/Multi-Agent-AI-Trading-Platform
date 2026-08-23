import { describe, it, expect } from 'vitest';
import { tradingSafety } from '../config/tradingSafety';
import { EVENTS } from '../core/eventNames';

describe('manual trade consensus config', () => {
  it('keeps consensus floors and has co-eval timeout', () => {
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
    expect(tradingSafety.consensusAggregationWindowMs).toBe(500);
    expect(tradingSafety.manualTradeCoEvalTimeoutMs).toBeGreaterThanOrEqual(5000);
  });

  it('registers MANUAL_TRADE_EVALUATION_REQUESTED and TRADE_REJECTED_CONSENSUS events', () => {
    expect(EVENTS.MANUAL_TRADE_EVALUATION_REQUESTED).toBe('MANUAL_TRADE_EVALUATION_REQUESTED');
    expect(EVENTS.TRADE_REJECTED_CONSENSUS).toBe('TRADE_REJECTED_CONSENSUS');
    expect(EVENTS.TRADE_APPROVED).toBe('TRADE_APPROVED');
  });
});
