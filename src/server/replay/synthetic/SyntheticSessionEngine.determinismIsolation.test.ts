import { describe, it, expect, afterEach } from 'vitest';
import { SyntheticSessionEngine } from './SyntheticSessionEngine';

/**
 * Determinism fix regression (2026-09-15, Rule 2 of the market-open simulator follow-up mandate).
 * prepareIsolatedEnvironment() must force ARGUS_NEWS_ENGINE_ENABLED='false' - the env-level half of
 * the fix that stops ArgusCoreBoot.ts's real RSS/LLM NewsEngine from starting inside an isolated
 * synthetic simulation process. (The FundamentalAgent/MacroAgent in-process disable lives in run(),
 * which requires a full boot to exercise meaningfully - covered qualitatively by the confirmed
 * same-seed QUIET_OPEN determinism re-check, not re-asserted here as a unit test.)
 */
describe('SyntheticSessionEngine - prepareIsolatedEnvironment news determinism isolation', () => {
  const envKeysToRestore = [
    'SYNTHETIC_SIMULATION', 'PAPER_TRADING_ONLY', 'ARGUS_DB_PATH', 'ARGUS_DISABLE_MARKET_DATA_WS',
    'ARGUS_DISABLE_HEAP_SNAPSHOTS', 'OPENALICE_ENABLED', 'ARGUS_OPPORTUNITY_LOOP_ENABLED',
    'ARGUS_BROAD_UNIVERSE_ENABLED', 'ARGUS_MARKET_MOVERS_ENABLED', 'ARGUS_ACTIVE_BROKER',
    'ARGUS_NEWS_ENGINE_ENABLED',
  ];
  const snapshot: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of envKeysToRestore) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  it('forces ARGUS_NEWS_ENGINE_ENABLED=false so ArgusCoreBoot skips the real NewsEngine', () => {
    for (const key of envKeysToRestore) snapshot[key] = process.env[key];

    const engine = new SyntheticSessionEngine();
    engine.prepareIsolatedEnvironment({
      simulationId: `determinism-isolation-test-${Date.now()}`,
      scenarioId: 'QUIET_OPEN',
      seed: 1,
    } as any);

    expect(process.env.ARGUS_NEWS_ENGINE_ENABLED).toBe('false');
  });
});
