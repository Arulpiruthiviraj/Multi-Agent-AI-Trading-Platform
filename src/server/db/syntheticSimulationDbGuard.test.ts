import { describe, it, expect } from 'vitest';
import path from 'path';
import { assertSyntheticSimulationNotOpeningProductionDb } from './syntheticSimulationDbGuard';

/**
 * Pure-function unit tests, deliberately never touching a real file - see this module's own
 * header comment for why db/index.ts's guard logic was extracted here specifically so it could be
 * proven correct with fake paths, without any test risking opening the real production database
 * to verify the guard actually blocks it.
 */
describe('assertSyntheticSimulationNotOpeningProductionDb (mechanical isolation guard)', () => {
  const PROD_PATH = path.join('C:', 'WorkProjects', 'Multi-Agent-AI-Trading-Platform', 'data', 'argus.db');

  it('throws when isSyntheticSimulation=true and the requested path IS the production path', () => {
    expect(() => assertSyntheticSimulationNotOpeningProductionDb(true, PROD_PATH, PROD_PATH))
      .toThrow(/FATAL.*SYNTHETIC_SIMULATION.*production database/);
  });

  it('throws even when the requested path is a differently-spelled (relative/redundant) reference to the same file', () => {
    const relativeSpelling = path.join('C:', 'WorkProjects', 'Multi-Agent-AI-Trading-Platform', 'data', '..', 'data', 'argus.db');
    expect(() => assertSyntheticSimulationNotOpeningProductionDb(true, relativeSpelling, PROD_PATH)).toThrow(/FATAL/);
  });

  it('does NOT throw when isSyntheticSimulation=true and the requested path is a genuinely isolated tmp file', () => {
    const isolatedPath = path.join('C:', 'Users', 'someone', 'AppData', 'Local', 'Temp', 'argus_synthetic_sim_test123.db');
    expect(() => assertSyntheticSimulationNotOpeningProductionDb(true, isolatedPath, PROD_PATH)).not.toThrow();
  });

  it('does NOT throw when isSyntheticSimulation=false, even if the path IS the production path - this guard is scoped to simulation sessions only, never fires for a normal live/paper boot', () => {
    expect(() => assertSyntheticSimulationNotOpeningProductionDb(false, PROD_PATH, PROD_PATH)).not.toThrow();
  });

  it('the thrown error names the exact resolved production path, for a legible failure message', () => {
    try {
      assertSyntheticSimulationNotOpeningProductionDb(true, PROD_PATH, PROD_PATH);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(path.resolve(PROD_PATH));
    }
  });
});
