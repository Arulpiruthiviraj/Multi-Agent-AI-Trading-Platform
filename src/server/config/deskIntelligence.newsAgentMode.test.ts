import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Phase F Step 2 — NEWS_AGENT_MODE config scaffolding. This is deliberately a config-only change:
 * the real default (`CATALYST_ONLY`) must behave identically to the old `newsEmitsTradeIdeas:
 * false` default it replaces. No other Phase F behavior (real clustering, structured assessment
 * fields, prediction ledger) is implemented yet - see ARGUS_PHASE_F_NEWS_ARCHITECTURE_AUDIT.md.
 */
describe('deskIntelligence.newsAgentMode loader validation', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.doUnmock('./loadRepoConfigJson');
  });

  it('accepts every documented mode', async () => {
    for (const mode of ['DISABLED', 'CATALYST_ONLY', 'ACTIVE_OBSERVE', 'ACTIVE_VOTE', 'ACTIVE_VOTE_AND_VETO']) {
      vi.resetModules();
      vi.doMock('./loadRepoConfigJson', () => ({
        loadRepoConfigJson: () => ({
          minRiskRewardRatio: 1.5,
          highVolatilityConfidenceMultiplier: 0.85,
          newsAgentMode: mode,
          probabilityQuality: { empiricallyValidated: 'E', modelEstimate: 'M', unavailable: 'U' },
          dataQuality: { greenMaxStaleMs: 1, yellowMaxStaleMs: 2 },
          strategyFamilies: {},
          regimeFamilyRelevance: {},
        }),
      }));
      const mod = await import('./deskIntelligence');
      expect(mod.deskIntelligence.newsAgentMode).toBe(mode);
    }
  });

  it('fails boot on a missing newsAgentMode', async () => {
    vi.doMock('./loadRepoConfigJson', () => ({
      loadRepoConfigJson: () => ({
        minRiskRewardRatio: 1.5,
        highVolatilityConfidenceMultiplier: 0.85,
        probabilityQuality: { empiricallyValidated: 'E', modelEstimate: 'M', unavailable: 'U' },
        dataQuality: { greenMaxStaleMs: 1, yellowMaxStaleMs: 2 },
        strategyFamilies: {},
        regimeFamilyRelevance: {},
      }),
    }));
    await expect(import('./deskIntelligence')).rejects.toThrow(/newsAgentMode/);
  });

  it('fails boot on an invalid newsAgentMode string', async () => {
    vi.doMock('./loadRepoConfigJson', () => ({
      loadRepoConfigJson: () => ({
        minRiskRewardRatio: 1.5,
        highVolatilityConfidenceMultiplier: 0.85,
        newsAgentMode: 'SOMETHING_MADE_UP',
        probabilityQuality: { empiricallyValidated: 'E', modelEstimate: 'M', unavailable: 'U' },
        dataQuality: { greenMaxStaleMs: 1, yellowMaxStaleMs: 2 },
        strategyFamilies: {},
        regimeFamilyRelevance: {},
      }),
    }));
    await expect(import('./deskIntelligence')).rejects.toThrow(/newsAgentMode/);
  });
});

describe('newsAgentEmitsTradeIdeas / newsAgentPipelineEnabled (real config)', () => {
  it('derives false/true correctly from the real repo config default (CATALYST_ONLY)', async () => {
    const { deskIntelligence, newsAgentEmitsTradeIdeas, newsAgentPipelineEnabled, newsAgentObservesPredictions } = await import('./deskIntelligence');
    expect(deskIntelligence.newsAgentMode).toBe('CATALYST_ONLY');
    expect(newsAgentEmitsTradeIdeas()).toBe(false);
    expect(newsAgentPipelineEnabled()).toBe(true);
    // Phase F5: the prediction ledger stays dormant at the real repo default.
    expect(newsAgentObservesPredictions()).toBe(false);
  });
});

describe('newsAgentObservesPredictions (Phase F5 - per-mode matrix)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./loadRepoConfigJson');
  });

  it.each([
    ['DISABLED', false],
    ['CATALYST_ONLY', false],
    ['ACTIVE_OBSERVE', true],
    ['ACTIVE_VOTE', true],
    ['ACTIVE_VOTE_AND_VETO', true],
  ] as const)('mode %s -> observesPredictions=%s', async (mode, expected) => {
    vi.doMock('./loadRepoConfigJson', () => ({
      loadRepoConfigJson: () => ({
        minRiskRewardRatio: 1.5,
        highVolatilityConfidenceMultiplier: 0.85,
        newsAgentMode: mode,
        probabilityQuality: { empiricallyValidated: 'E', modelEstimate: 'M', unavailable: 'U' },
        dataQuality: { greenMaxStaleMs: 1, yellowMaxStaleMs: 2 },
        strategyFamilies: {},
        regimeFamilyRelevance: {},
      }),
    }));
    const { newsAgentObservesPredictions } = await import('./deskIntelligence');
    expect(newsAgentObservesPredictions()).toBe(expected);
  });
});
