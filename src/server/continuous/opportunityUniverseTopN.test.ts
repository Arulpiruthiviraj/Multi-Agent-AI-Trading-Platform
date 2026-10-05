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
import { structuredLogger } from '../observability/StructuredLogger';
import { resetBroadUniverseAllocatorForTests } from './BroadUniverseSubscriptionAllocator';

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

  // 2026-10-05 (Admitted -> Challenger Eligibility Gap Forensic): before this fix, an ADV-admitted
  // broad-universe candidate excluded by this exact top-N cap (confirmed live for MPWR on
  // 2026-10-05 - admitted into the broad-universe cache but never selected here, so it never
  // reached `shortlist`, the challenger scorer, or any subscription attempt) left no trace
  // anywhere in observability_events. This proves the new BROAD_UNIVERSE_TOPN_TRUNCATED event
  // now records exactly who got excluded and why, without changing which symbols get selected.
  it('logs BROAD_UNIVERSE_TOPN_TRUNCATED with the excluded symbols when the cap bites', () => {
    const originalTopN = continuousIntelligence.broadUniverseTopNPerScan;
    (continuousIntelligence as any).broadUniverseTopNPerScan = 3;
    resetBroadUniverseAllocatorForTests();
    const spy = vi.spyOn(structuredLogger, 'info');
    try {
      getOpportunityScanUniverse();
      const call = spy.mock.calls.find((c) => (c[1] as any)?.eventType === 'BROAD_UNIVERSE_TOPN_TRUNCATED');
      expect(call).toBeDefined();
      const payload = call![1] as any;
      expect(payload.admittedCount).toBe(5);
      expect(payload.selectedCount).toBe(3);
      expect(payload.excludedCount).toBe(2);
      expect(payload.capacity).toBe(3);
      const excludedSymbols = payload.excludedSample.map((c: any) => c.symbol);
      expect(excludedSymbols).toEqual(expect.arrayContaining(['FOURTH', 'FIFTH']));
      expect(excludedSymbols).not.toContain('BEST');
    } finally {
      spy.mockRestore();
      resetBroadUniverseAllocatorForTests();
      (continuousIntelligence as any).broadUniverseTopNPerScan = originalTopN;
    }
  });

  it('does not log BROAD_UNIVERSE_TOPN_TRUNCATED when every admitted candidate fits under the cap', () => {
    const originalTopN = continuousIntelligence.broadUniverseTopNPerScan;
    (continuousIntelligence as any).broadUniverseTopNPerScan = 10;
    resetBroadUniverseAllocatorForTests();
    const spy = vi.spyOn(structuredLogger, 'info');
    try {
      getOpportunityScanUniverse();
      const call = spy.mock.calls.find((c) => (c[1] as any)?.eventType === 'BROAD_UNIVERSE_TOPN_TRUNCATED');
      expect(call).toBeUndefined();
    } finally {
      spy.mockRestore();
      resetBroadUniverseAllocatorForTests();
      (continuousIntelligence as any).broadUniverseTopNPerScan = originalTopN;
    }
  });
});
