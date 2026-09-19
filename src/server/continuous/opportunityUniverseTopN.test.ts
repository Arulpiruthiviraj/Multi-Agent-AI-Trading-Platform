import { describe, it, expect, vi } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';

// The first allocator cycle favors liquidity while keeping the configured cap.
// Subsequent-cycle aging/fairness is covered in BroadUniverseSubscriptionAllocator.test.ts.
vi.mock('./MarketUniverseScanner', () => ({
  getCachedBroadUniverseSymbols: () => ['BEST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH'],
  getCachedBroadUniverseCandidatesWithVolume: () => ['BEST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH']
    .map((symbol, i) => ({ symbol, dollarVolume: (5 - i) * 1_000_000 })),
  getCachedMoverSymbols: () => [],
  getCachedNewsCatalystSymbols: () => [],
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
