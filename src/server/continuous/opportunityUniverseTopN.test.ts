import { describe, it, expect, vi } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';

// getCachedBroadUniverseSymbols() is already ranked by real dollar volume descending (see
// MarketUniverseScanner.test.ts) - this test only needs to prove getOpportunityScanUniverse()
// takes the real top-N off that ranked list rather than folding in the whole cached set.
vi.mock('./MarketUniverseScanner', () => ({
  getCachedBroadUniverseSymbols: () => ['BEST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH'],
  marketUniverseScannerWorker: { start: vi.fn(), stop: vi.fn() },
}));

import { getOpportunityScanUniverse } from './OpportunityDiscovery';

describe('getOpportunityScanUniverse - broad-universe top-N cap', () => {
  it('only folds in the top broadUniverseTopNPerScan ranked broad-universe symbols', () => {
    const originalTopN = continuousIntelligence.broadUniverseTopNPerScan;
    (continuousIntelligence as any).broadUniverseTopNPerScan = 3;
    try {
      const universe = getOpportunityScanUniverse();
      expect(universe).toContain('BEST');
      expect(universe).toContain('SECOND');
      expect(universe).toContain('THIRD');
      expect(universe).not.toContain('FOURTH');
      expect(universe).not.toContain('FIFTH');
    } finally {
      (continuousIntelligence as any).broadUniverseTopNPerScan = originalTopN;
    }
  });
});
