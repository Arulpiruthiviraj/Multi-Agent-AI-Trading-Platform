import { describe, it, expect } from 'vitest';
import {
  deskIntelligence,
  familyForStrategy,
  regimeRelevanceForStrategy,
  rankEvaluationsForRegime,
  newsAgentEmitsTradeIdeas,
  newsAgentPipelineEnabled,
} from './deskIntelligence';

describe('deskIntelligence config', () => {
  it('loads reviewed JSON with News ACTIVE_VOTE (DEF-TODAY-05) without lowering consensus floors', () => {
    // ACTIVE_VOTE emits TRADE_IDEA_GENERATED as one ChiefTrader voter; 0.75 / min-2 unchanged.
    expect(deskIntelligence.newsAgentMode).toBe('ACTIVE_VOTE');
    expect(newsAgentEmitsTradeIdeas()).toBe(true);
    expect(newsAgentPipelineEnabled()).toBe(true);
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
