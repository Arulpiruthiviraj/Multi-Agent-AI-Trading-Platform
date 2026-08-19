import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Real bug found and fixed this pass: agentWeights.ts validated pipelineAgents and
 * consensusHardVetoAgents but never defaults/consensusDebateWeight/unlistedAgentWeight/
 * riskExitAgent, even though every other config loader in this codebase (tradingSafety.ts,
 * quantThresholds.ts, multiAsset.ts, ...) throws at boot for a missing required field.
 * resolveWeight() in ChiefTraderAgent.ts falls back to unlistedAgentWeight for any agent not in
 * the seeded default map - a missing value there used to silently become `undefined`, not a
 * boot-time failure.
 */
describe('config/agentWeights.ts validation', () => {
  const VALID = {
    defaults: { TechnicalAgent: 0.25, NewsAgent: 0.25 },
    consensusDebateWeight: 0.35,
    unlistedAgentWeight: 1.0,
    riskExitAgent: 'PortfolioManager',
    pipelineAgents: ['TechnicalAgent'],
    consensusHardVetoAgents: ['NewsAgent'],
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('./loadRepoConfigJson');
  });

  async function loadWith(overrides: Record<string, unknown>) {
    vi.doMock('./loadRepoConfigJson', () => ({
      loadRepoConfigJson: () => ({ ...VALID, ...overrides }),
    }));
    return import('./agentWeights');
  }

  it('loads successfully with a fully valid config', async () => {
    const mod = await loadWith({});
    expect(mod.agentWeightConfig.unlistedAgentWeight).toBe(1.0);
    expect(mod.defaultAgentWeights.TechnicalAgent).toBe(0.25);
  });

  it('throws at load time when defaults is missing', async () => {
    await expect(loadWith({ defaults: undefined })).rejects.toThrow(/defaults/);
  });

  it('throws at load time when defaults has a non-numeric value', async () => {
    await expect(loadWith({ defaults: { TechnicalAgent: 'a lot' } })).rejects.toThrow(/defaults/);
  });

  it('throws at load time when consensusDebateWeight is missing', async () => {
    await expect(loadWith({ consensusDebateWeight: undefined })).rejects.toThrow(/consensusDebateWeight/);
  });

  it('throws at load time when unlistedAgentWeight is missing', async () => {
    await expect(loadWith({ unlistedAgentWeight: undefined })).rejects.toThrow(/unlistedAgentWeight/);
  });

  it('throws at load time when riskExitAgent is missing', async () => {
    await expect(loadWith({ riskExitAgent: undefined })).rejects.toThrow(/riskExitAgent/);
  });
});
