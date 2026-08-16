import { describe, it, expect } from 'vitest';
import {
  deskIntelligence,
  familyForStrategy,
  regimeRelevanceForStrategy,
  rankEvaluationsForRegime,
} from './deskIntelligence';

describe('deskIntelligence config', () => {
  it('loads reviewed JSON and never emits news as a default BUY/SELL idea', () => {
    expect(deskIntelligence.newsEmitsTradeIdeas).toBe(false);
    expect(deskIntelligence.minRiskRewardRatio).toBeGreaterThan(0);
    expect(familyForStrategy('MOMENTUM_BREAKOUT')).toBe('momentum');
    expect(familyForStrategy('MEAN_REVERSION')).toBe('mean_reversion');
  });

  it('ranks mean reversion above momentum in a sideways regime without looking at future bars', () => {
    const ranked = rankEvaluationsForRegime(
      [
        { strategy: 'MOMENTUM_BREAKOUT', setupScore: 80, confidence: 0.8 },
        { strategy: 'MEAN_REVERSION', setupScore: 70, confidence: 0.7 },
      ],
      'SIDEWAYS_RANGE',
    );
    expect(ranked[0].strategy).toBe('MEAN_REVERSION');
    expect(ranked[0].regimeRelevance).toBe(deskIntelligence.regimeFamilyRelevance.SIDEWAYS_RANGE.mean_reversion);
    expect(regimeRelevanceForStrategy('MOMENTUM_BREAKOUT', 'SIDEWAYS_RANGE')).toBeLessThan(
      regimeRelevanceForStrategy('MEAN_REVERSION', 'SIDEWAYS_RANGE'),
    );
  });
});
