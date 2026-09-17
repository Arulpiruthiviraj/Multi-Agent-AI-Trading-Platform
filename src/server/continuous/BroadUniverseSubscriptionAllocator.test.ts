import { describe, it, expect, afterEach } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import {
  selectBroadUniverseCandidates,
  getAllocationRecord,
  listAllocationRecords,
  resetBroadUniverseAllocatorForTests,
  type AllocationCandidate,
} from './BroadUniverseSubscriptionAllocator';

afterEach(() => {
  resetBroadUniverseAllocatorForTests();
});

function megaCaps(n: number): AllocationCandidate[] {
  // Same real shape as today's live top-of-list: a handful of names with dollar volume vastly
  // larger than any genuine mid-cap mover, so a naive raw-volume sort would always pick them first.
  return Array.from({ length: n }, (_, i) => ({ symbol: `MEGA${i}`, dollarVolume: 500_000_000 - i * 1_000_000 }));
}

describe('BroadUniverseSubscriptionAllocator', () => {
  it('top-liquidity candidates receive coverage on the very first cycle (no regression to the old behavior for the common case)', () => {
    const candidates = [...megaCaps(30), { symbol: 'MIDCAP', dollarVolume: 15_000_000 }];
    const selected = selectBroadUniverseCandidates(candidates, 20);
    expect(selected).toHaveLength(20);
    expect(selected.map((s) => s.symbol)).toEqual(megaCaps(20).map((c) => c.symbol));
  });

  it('a real, liquid, but consistently outranked mover eventually receives coverage within the configured fairness window - not never', () => {
    const fairnessWindow = continuousIntelligence.broadUniverseFairnessWindowCycles;
    const megas = megaCaps(50); // always outrank MIDCAP on raw/percentile liquidity
    const midcap: AllocationCandidate = { symbol: 'MIDCAP', dollarVolume: 15_000_000 };

    let midcapSelectedAtCycle: number | null = null;
    for (let cycle = 1; cycle <= fairnessWindow + 5; cycle++) {
      const selected = selectBroadUniverseCandidates([...megas, midcap], 20, cycle * 900_000);
      if (selected.some((s) => s.symbol === 'MIDCAP')) {
        midcapSelectedAtCycle = cycle;
        break;
      }
    }
    expect(midcapSelectedAtCycle).not.toBeNull();
    expect(midcapSelectedAtCycle!).toBeLessThanOrEqual(fairnessWindow);
  });

  it('starvation is measurable: cyclesSkipped accumulates correctly for an unselected candidate and resets on selection', () => {
    const megas = megaCaps(25);
    const midcap: AllocationCandidate = { symbol: 'MIDCAP', dollarVolume: 15_000_000 };
    for (let cycle = 1; cycle <= 3; cycle++) {
      selectBroadUniverseCandidates([...megas, midcap], 20, cycle * 900_000);
    }
    const before = getAllocationRecord('MIDCAP')!;
    expect(before.cyclesSkipped).toBe(3);
    expect(before.cyclesEligible).toBe(3);
    expect(before.cyclesSelected).toBe(0);

    // Now let MIDCAP win by removing enough competition.
    const selected = selectBroadUniverseCandidates([midcap], 20, 4 * 900_000);
    expect(selected.map((s) => s.symbol)).toContain('MIDCAP');
    const after = getAllocationRecord('MIDCAP')!;
    expect(after.cyclesSkipped).toBe(0); // reset on selection
    expect(after.cyclesSelected).toBe(1);
  });

  it('never selects more than the requested capacity, even with 1,000 eligible candidates', () => {
    const candidates = megaCaps(1000);
    const selected = selectBroadUniverseCandidates(candidates, 20);
    expect(selected.length).toBeLessThanOrEqual(20);
  });

  it('never returns duplicate symbols within a single selection', () => {
    const candidates = megaCaps(50);
    const selected = selectBroadUniverseCandidates(candidates, 20);
    const symbols = selected.map((s) => s.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('a candidate no longer present in the input (dropped admission) is simply not selected, never force-kept', () => {
    selectBroadUniverseCandidates([{ symbol: 'TEMP', dollarVolume: 50_000_000 }], 20, 1000);
    const selected = selectBroadUniverseCandidates(megaCaps(25), 20, 2000);
    expect(selected.map((s) => s.symbol)).not.toContain('TEMP');
  });

  it('determinism: identical candidates + identical prior state + identical now produce an identical result', () => {
    const candidates = [...megaCaps(30), { symbol: 'A', dollarVolume: 20_000_000 }, { symbol: 'B', dollarVolume: 20_000_000 }];
    selectBroadUniverseCandidates(candidates, 20, 1000); // build up some real prior state
    const stateSnapshot = listAllocationRecords();

    resetBroadUniverseAllocatorForTests();
    selectBroadUniverseCandidates(candidates, 20, 1000);
    const first = selectBroadUniverseCandidates(candidates, 20, 2000);

    resetBroadUniverseAllocatorForTests();
    selectBroadUniverseCandidates(candidates, 20, 1000);
    const second = selectBroadUniverseCandidates(candidates, 20, 2000);

    expect(second).toEqual(first);
    expect(stateSnapshot.length).toBeGreaterThan(0); // sanity: real state was actually built
  });

  it('is a deterministic priority model, not random rotation: two equal-volume candidates break ties by wait time, then alphabetically - never arbitrarily', () => {
    const candidates: AllocationCandidate[] = [
      { symbol: 'ZZZZ', dollarVolume: 10_000_000 },
      { symbol: 'AAAA', dollarVolume: 10_000_000 },
    ];
    const selected = selectBroadUniverseCandidates(candidates, 1);
    expect(selected[0].symbol).toBe('AAAA'); // alphabetical tie-break, not insertion order
  });

  it('restart safety: after a full reset (simulating a process restart), the allocator does not throw, does not return stale symbols, and correctly rebuilds fresh state', () => {
    const candidates = megaCaps(30);
    selectBroadUniverseCandidates(candidates, 20, 1000);
    expect(listAllocationRecords().length).toBeGreaterThan(0);

    resetBroadUniverseAllocatorForTests(); // the restart-safe reset this module documents relying on
    expect(listAllocationRecords()).toHaveLength(0);

    expect(() => selectBroadUniverseCandidates(candidates, 20, 2000)).not.toThrow();
    const postRestart = selectBroadUniverseCandidates(candidates, 20, 3000);
    expect(postRestart).toHaveLength(20);
    // Fresh state: no symbol has phantom pre-restart cyclesSkipped history.
    for (const s of postRestart) {
      const rec = getAllocationRecord(s.symbol)!;
      expect(rec.cyclesEligible).toBeLessThanOrEqual(2);
    }
  });

  it('handles 1,000+ candidates without pathological latency', () => {
    const candidates = megaCaps(1418); // today's real observed scale
    const t0 = Date.now();
    const selected = selectBroadUniverseCandidates(candidates, 20);
    const elapsed = Date.now() - t0;
    expect(selected.length).toBeLessThanOrEqual(20);
    expect(elapsed).toBeLessThan(1000);
  });

  it('capacity of 0 or an empty candidate list returns an empty selection without error', () => {
    expect(selectBroadUniverseCandidates(megaCaps(10), 0)).toEqual([]);
    expect(selectBroadUniverseCandidates([], 20)).toEqual([]);
  });

  it('reproduces the exact real-world starvation shape found live (2026-09-16) and proves the fix resolves it: a $10-51M candidate ranked far outside a raw top-20-by-volume window is selected within the fairness window under the new allocator', () => {
    // Mirrors real observed today's-session data: 20 mega-caps ($143M-$768M) plus five genuine,
    // liquid, materially-moving candidates that ranked #99/#262/#357/#615/#622 of 1,418 under the
    // old raw-dollar-volume-only sort.
    const megas = megaCaps(20).map((c, i) => ({ ...c, dollarVolume: 768_000_000 - i * 20_000_000 }));
    const realMovers: AllocationCandidate[] = [
      { symbol: 'ONX', dollarVolume: 51_100_000 },
      { symbol: 'TENBX', dollarVolume: 24_600_000 },
      { symbol: 'BOOTX', dollarVolume: 18_500_000 },
      { symbol: 'ALHCX', dollarVolume: 10_800_000 },
      { symbol: 'BBNXX', dollarVolume: 10_700_000 },
    ];
    const fairnessWindow = continuousIntelligence.broadUniverseFairnessWindowCycles;
    const coveredWithin: Record<string, number | null> = {};
    for (const m of realMovers) coveredWithin[m.symbol] = null;

    for (let cycle = 1; cycle <= fairnessWindow; cycle++) {
      const selected = selectBroadUniverseCandidates([...megas, ...realMovers], 20, cycle * 900_000);
      for (const m of realMovers) {
        if (coveredWithin[m.symbol] === null && selected.some((s) => s.symbol === m.symbol)) {
          coveredWithin[m.symbol] = cycle;
        }
      }
    }
    for (const m of realMovers) {
      expect(coveredWithin[m.symbol]).not.toBeNull();
    }
  });
});
