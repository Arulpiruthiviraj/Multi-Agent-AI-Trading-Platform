import { describe, it, expect } from 'vitest';
import { classifyConsensusTerminalReason } from './consensusTerminalReason';

const base = {
  approved: false,
  side: 'BUY',
  confidence: 0.5,
  strongThreshold: 0.75,
  enoughIndependentVoices: true,
  debateSaidHold: false,
  bearSaidHold: false,
  aiContradicts: false,
  holdIsDataUnavailable: false,
};

describe('classifyConsensusTerminalReason', () => {
  it('returns CONSENSUS_APPROVED whenever approved is true, regardless of other fields', () => {
    expect(classifyConsensusTerminalReason({ ...base, approved: true, side: 'HOLD' })).toBe('CONSENSUS_APPROVED');
  });

  it('returns AGENT_DATA_UNAVAILABLE for a winning HOLD flagged as data-unavailable', () => {
    expect(classifyConsensusTerminalReason({ ...base, side: 'HOLD', holdIsDataUnavailable: true })).toBe('AGENT_DATA_UNAVAILABLE');
  });

  it('returns AGENT_HOLD for a winning HOLD not flagged as data-unavailable', () => {
    expect(classifyConsensusTerminalReason({ ...base, side: 'HOLD' })).toBe('AGENT_HOLD');
  });

  it('returns INSUFFICIENT_AGENT_PARTICIPATION when confidence clears STRONG but independence does not', () => {
    expect(classifyConsensusTerminalReason({ ...base, confidence: 0.9, enoughIndependentVoices: false })).toBe('INSUFFICIENT_AGENT_PARTICIPATION');
  });

  it('returns HARD_VETO when confidence and independence both clear but a hard veto fires', () => {
    expect(classifyConsensusTerminalReason({ ...base, confidence: 0.9, debateSaidHold: true })).toBe('HARD_VETO');
    expect(classifyConsensusTerminalReason({ ...base, confidence: 0.9, bearSaidHold: true })).toBe('HARD_VETO');
    expect(classifyConsensusTerminalReason({ ...base, confidence: 0.9, aiContradicts: true })).toBe('HARD_VETO');
  });

  it('returns CONFIDENCE_BELOW_STRONG for a low-confidence BUY/SELL with no MODERATE reason code (tier disabled/not attempted)', () => {
    expect(classifyConsensusTerminalReason({ ...base, confidence: 0.5 })).toBe('CONFIDENCE_BELOW_STRONG');
  });

  it('maps each MODERATE reasonCode to its own terminal code', () => {
    expect(classifyConsensusTerminalReason({ ...base, moderateReasonCode: 'MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE' })).toBe('MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE');
    expect(classifyConsensusTerminalReason({ ...base, moderateReasonCode: 'MODERATE_REJECT_UNTRUSTED_CALIBRATION' })).toBe('MODERATE_REJECT_CALIBRATION');
    expect(classifyConsensusTerminalReason({ ...base, moderateReasonCode: 'MODERATE_REJECT_LOW_CONFIDENCE' })).toBe('MODERATE_REJECT_LOW_CONFIDENCE');
    expect(classifyConsensusTerminalReason({ ...base, moderateReasonCode: 'MODERATE_TIER_DISABLED' })).toBe('MODERATE_TIER_DISABLED');
    expect(classifyConsensusTerminalReason({ ...base, moderateReasonCode: 'MODERATE_REJECT_HARD_VETO' })).toBe('HARD_VETO');
  });
});
