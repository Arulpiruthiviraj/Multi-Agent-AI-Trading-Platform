import { describe, it, expect } from 'vitest';
import { buildEliteTraderDecision } from './EliteTraderDecision';
import { scoreConfluence } from './ConfluenceEngine';
import { rankSetups } from './SetupEngine';
import { canVote, summarizeRoleConsensus } from './ModelRoleConsensus';

describe('EliteTraderDecision', () => {
  it('does not invent a liquidity probability and defaults to WAIT without a strategy evaluation', () => {
    const d = buildEliteTraderDecision({ symbol: 'AAPL' });
    expect(d.disposition).toBe('WAIT');
    expect(d.scores.LiquidityScore.value).toBeNull();
    expect(d.scores.LiquidityScore.evidenceQuality).toBe('UNAVAILABLE');
    expect(d.questions.L_liquidity).toBe('DATA UNAVAILABLE');
  });
});

describe('ConfluenceEngine', () => {
  it('collapses correlated oscillators into one group', () => {
    const c = scoreConfluence({
      hasStructure: true,
      hasVolume: false,
      hasVwap: false,
      hasIndex: false,
      hasSector: false,
      hasCatalyst: false,
      hasFavorableRr: false,
      hasCleanInvalidation: false,
      oscillatorBuyCount: 3,
    });
    expect(c.oscillatorCollapsed).toBe(true);
    expect(c.independentGroupsHit).toContain('oscillators');
    expect(c.independentGroupsHit.filter((g) => g === 'oscillators')).toHaveLength(1);
  });
});

describe('SetupEngine', () => {
  it('marks ORB as unavailable rather than fabricating a detector', () => {
    const { ranked } = rankSetups({});
    const orb = ranked.find((s) => s.id === 'OPENING_RANGE_BREAKOUT');
    expect(orb?.available).toBe(false);
    expect(orb?.why).toMatch(/No detector/);
  });
});

describe('ModelRoleConsensus', () => {
  it('refuses a forecast model as a RISK voter', () => {
    expect(canVote('KronosForecastAgent', 'RISK')).toBe(false);
    expect(canVote('RiskEngine', 'RISK')).toBe(true);
  });

  it('does not treat missing responses as agreement', () => {
    const s = summarizeRoleConsensus([
      { agent: 'TechnicalAgent', role: 'TECHNICAL', present: true, stale: false, lowConfidence: false, side: 'BUY' },
      { agent: 'QuantEngine', role: 'QUANT', present: false, stale: false, lowConfidence: false },
    ]);
    expect(s.missing).toBe(1);
    expect(s.note).toMatch(/Low-quality/);
  });
});
