import { describe, it, expect } from 'vitest';
import { deriveIdeaFromRegime } from './QuantSignalAgent';
import { RegimeResult } from '../quant/RegimeEngine';

function fakeRegime(overrides: Partial<RegimeResult>): RegimeResult {
  return {
    regime: 'SIDEWAYS_RANGE',
    trendStrength: 0,
    volatility: 'NORMAL',
    marketStructure: 'CHOPPY',
    confidence: 0,
    features: {} as any,
    insufficientData: false,
    ...overrides,
  };
}

describe('deriveIdeaFromRegime (Phase 3 baseline mapping)', () => {
  it('emits a real BUY idea for a confident BULLISH_TREND regime', () => {
    const idea = deriveIdeaFromRegime(fakeRegime({ regime: 'BULLISH_TREND', confidence: 0.8 }));
    expect(idea).not.toBeNull();
    expect(idea!.side).toBe('BUY');
    expect(idea!.confidence).toBe(0.8);
  });

  it('emits a real SELL idea for a confident BEARISH_TREND regime', () => {
    const idea = deriveIdeaFromRegime(fakeRegime({ regime: 'BEARISH_TREND', confidence: 0.75 }));
    expect(idea).not.toBeNull();
    expect(idea!.side).toBe('SELL');
  });

  it('emits nothing for SIDEWAYS_RANGE regardless of confidence', () => {
    expect(deriveIdeaFromRegime(fakeRegime({ regime: 'SIDEWAYS_RANGE', confidence: 0.95 }))).toBeNull();
  });

  it('emits nothing when confidence is below the minimum threshold, even for a directional regime', () => {
    expect(deriveIdeaFromRegime(fakeRegime({ regime: 'BULLISH_TREND', confidence: 0.3 }))).toBeNull();
  });

  it('emits nothing when the regime is honestly flagged insufficientData, regardless of confidence', () => {
    expect(deriveIdeaFromRegime(fakeRegime({ regime: 'BULLISH_TREND', confidence: 0.9, insufficientData: true }))).toBeNull();
  });
});
