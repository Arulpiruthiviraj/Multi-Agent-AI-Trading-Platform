import { describe, it, expect } from 'vitest';
import { parseStrategyFromOpeningTrade, UNATTRIBUTED_STRATEGY_ID } from './campaignStrategyAttribution';
import {
  recordCampaignNearMissConsensus,
  getCampaignEffortSnapshot,
  resetCampaignEffortForTests,
} from './campaignEffortTelemetry';
import { tradingSafety } from '../config/tradingSafety';

describe('campaignStrategyAttribution', () => {
  it('prefers quantStrategyId on the opening trade', () => {
    expect(parseStrategyFromOpeningTrade({
      quantStrategyId: 'MOMENTUM_BREAKOUT',
      reasoning: 'noise',
    })).toBe('MOMENTUM_BREAKOUT');
  });

  it('extracts CORE strategy from quantInvalidationJson when column is null', () => {
    expect(parseStrategyFromOpeningTrade({
      quantStrategyId: null,
      quantInvalidationJson: JSON.stringify({ strategy: 'MEAN_REVERSION', texts: [] }),
    })).toBe('MEAN_REVERSION');
  });

  it('returns UNATTRIBUTED when nothing resolvable', () => {
    expect(parseStrategyFromOpeningTrade({
      quantStrategyId: null,
      reasoning: 'Technical RSI bounce',
    })).toBe(UNATTRIBUTED_STRATEGY_ID);
  });
});

describe('campaignEffortTelemetry near-miss band', () => {
  it('counts confidence in [0.65, consensusThreshold)', () => {
    resetCampaignEffortForTests();
    recordCampaignNearMissConsensus(0.70);
    recordCampaignNearMissConsensus(0.74);
    recordCampaignNearMissConsensus(tradingSafety.consensusApprovalThreshold);
    recordCampaignNearMissConsensus(0.50);
    expect(getCampaignEffortSnapshot().nearMissConsensus).toBe(2);
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
  });
});
