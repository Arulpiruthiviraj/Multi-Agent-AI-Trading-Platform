/**
 * moverCohort tests (2026-10-06, local-only, Part B workstream H).
 * All provider I/O goes through injected fakes - no network, no keys needed.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMoverCohort,
  applyInvestableScreens,
  defaultScreenConfig,
  type MoverDataProvider,
  type MoverScreenConfig,
  type RawMover,
  type SnapshotEvidence,
  type DailyBarEvidence,
} from './moverCohort';
import { continuousIntelligence } from '../config/continuousIntelligence';

const TEST_CFG: MoverScreenConfig = {
  minPrice: 5,
  maxPrice: 10000,
  minDollarVolume: 5_000_000,
  maxSpreadBps: 50,
  minAdvShares: 500_000,
  fetchTopNPerSide: 10,
  scanTopNPerSide: 2,
};

const NOW_MS = Date.parse('2026-10-06T20:00:00Z'); // 16:00 EDT 2026-10-06

interface FakeSpec {
  available?: boolean;
  movers?: { gainers: RawMover[]; losers: RawMover[] };
  universe?: string[];
  snaps?: Record<string, SnapshotEvidence>;
  bars?: Record<string, DailyBarEvidence>;
  adv?: Record<string, number>;
  throwOn?: 'fetchRawMovers' | 'fetchTradableAssetSymbols' | 'fetchDailyBars';
}

function fakeProvider(spec: FakeSpec): MoverDataProvider {
  const boom = (what: string) => {
    if (spec.throwOn === what) throw new Error(`fake ${what} exploded`);
  };
  return {
    name: 'fake',
    isAvailable: () => spec.available ?? true,
    fetchRawMovers: async () => { boom('fetchRawMovers'); return spec.movers ?? { gainers: [], losers: [] }; },
    fetchTradableAssetSymbols: async () => { boom('fetchTradableAssetSymbols'); return spec.universe ?? []; },
    fetchSnapshots: async (symbols) => {
      const out = new Map<string, SnapshotEvidence>();
      for (const s of symbols) if (spec.snaps?.[s]) out.set(s, spec.snaps[s]);
      return out;
    },
    fetchDailyBars: async (symbols, _tradingDate) => {
      boom('fetchDailyBars');
      const out = new Map<string, DailyBarEvidence>();
      for (const s of symbols) if (spec.bars?.[s]) out.set(s, spec.bars[s]);
      return out;
    },
    fetchAdvShares: async (symbols) => {
      const out = new Map<string, number>();
      for (const s of symbols) if (spec.adv?.[s] != null) out.set(s, spec.adv[s]);
      return out;
    },
  };
}

const snap = (symbol: string, price = 50): SnapshotEvidence => ({
  symbol, price, dollarVolume: 10_000_000, spreadBps: 10, spreadCrossed: false,
});

describe('moverCohort', () => {
  it('degrades honestly to INSUFFICIENT_EVIDENCE when provider keys are absent - never fabricates movers', async () => {
    const result = await buildMoverCohort('2026-10-06', {
      provider: fakeProvider({ available: false }),
      screenConfig: TEST_CFG,
      nowMs: NOW_MS,
    });
    expect(result.insufficientEvidence).toBe(true);
    expect(result.members).toEqual([]);
    expect(result.providerAvailable).toBe(false);
    expect(result.insufficientReason).toMatch(/ALPACA_API_KEY/);
  });

  it('builds a same-date cohort from the screener with real bar-derived moves; penny noise excluded', async () => {
    const result = await buildMoverCohort('2026-10-06', {
      provider: fakeProvider({
        movers: {
          gainers: [
            { symbol: 'PNP', percentChange: 30, price: 2 },
            { symbol: 'AAA', percentChange: 25, price: 120 },
            { symbol: 'BBB', percentChange: 18, price: 60 },
            { symbol: 'CCC', percentChange: 12, price: 40 },
          ],
          losers: [
            { symbol: 'DDD', percentChange: -15, price: 80 },
            { symbol: 'EEE', percentChange: -9, price: 30 },
          ],
        },
        universe: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'PNP'],
        snaps: {
          PNP: snap('PNP', 2), AAA: snap('AAA', 120), BBB: snap('BBB', 60),
          CCC: snap('CCC', 40), DDD: snap('DDD', 80), EEE: snap('EEE', 30),
        },
        bars: {
          AAA: { prevClose: 100, close: 125, volume: 1_000_000 },
          BBB: { prevClose: 50, close: 59, volume: 2_000_000 },
          CCC: { prevClose: 40, close: 44.8, volume: 3_000_000 },
          DDD: { prevClose: 100, close: 85, volume: 1_500_000 },
          EEE: { prevClose: 30, close: 27.3, volume: 4_000_000 },
        },
        adv: { AAA: 2_000_000, BBB: 2_000_000, CCC: 2_000_000, DDD: 2_000_000, EEE: 2_000_000 },
      }),
      screenConfig: TEST_CFG,
      nowMs: NOW_MS,
    });
    expect(result.insufficientEvidence).toBe(false);
    // PNP (+30%, the screener's top gainer) is penny noise - excluded from the benchmark.
    expect(result.members.map((m) => m.symbol).sort()).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
    const aaa = result.members.find((m) => m.symbol === 'AAA')!;
    expect(aaa.eodMovePct).toBeCloseTo(25, 6);
    expect(aaa.referencePrice).toBe(100);
    expect(aaa.direction).toBe('GAINER');
    expect(aaa.screenerRank).toBe(2); // PNP was rank 1 before screening
    expect(aaa.beyondScanCap).toBe(false);
    expect(aaa.inTradableUniverse).toBe(true);
    const bbb = result.members.find((m) => m.symbol === 'BBB')!;
    expect(bbb.screenerRank).toBe(3);
    expect(bbb.beyondScanCap).toBe(true); // scanTopNPerSide = 2: the RANK_CAP case
    const ddd = result.members.find((m) => m.symbol === 'DDD')!;
    expect(ddd.direction).toBe('LOSER');
    expect(ddd.eodMovePct).toBeCloseTo(-15, 6);
    expect(result.universeSize).toBe(6);
  });

  it('excludes symbols failing the ADV stage (below floor vs no data)', async () => {
    const result = await buildMoverCohort('2026-10-06', {
      provider: fakeProvider({
        movers: {
          gainers: [
            { symbol: 'THIN', percentChange: 20, price: 60 },
            { symbol: 'NODATA', percentChange: 19, price: 60 },
            { symbol: 'GOOD', percentChange: 18, price: 60 },
          ],
          losers: [],
        },
        universe: ['THIN', 'NODATA', 'GOOD'],
        snaps: { THIN: snap('THIN'), NODATA: snap('NODATA'), GOOD: snap('GOOD') },
        bars: {
          THIN: { prevClose: 50, close: 60, volume: 1_000_000 },
          NODATA: { prevClose: 50, close: 59.5, volume: 1_000_000 },
          GOOD: { prevClose: 50, close: 59, volume: 1_000_000 },
        },
        adv: { THIN: 100_000, GOOD: 2_000_000 }, // NODATA absent -> ADV_DATA_UNAVAILABLE
      }),
      screenConfig: TEST_CFG,
      nowMs: NOW_MS,
    });
    expect(result.members.map((m) => m.symbol)).toEqual(['GOOD']);
  });

  it('builds a past-date cohort from historical bars over the tradable universe (backfill path)', async () => {
    const result = await buildMoverCohort('2026-10-05', {
      provider: fakeProvider({
        universe: ['AAA', 'BBB', 'DDD', 'PNP2'],
        bars: {
          AAA: { prevClose: 100, close: 120, volume: 1_000_000 }, // +20
          BBB: { prevClose: 50, close: 44, volume: 2_000_000 },    // -12
          DDD: { prevClose: 200, close: 210, volume: 500_000 },    // +5
          PNP2: { prevClose: 2, close: 3, volume: 10_000_000 },    // +50 but penny
        },
        adv: { AAA: 2_000_000, BBB: 2_000_000, DDD: 2_000_000, PNP2: 2_000_000 },
      }),
      screenConfig: TEST_CFG,
      nowMs: NOW_MS,
    });
    expect(result.insufficientEvidence).toBe(false);
    expect(result.members.map((m) => m.symbol).sort()).toEqual(['AAA', 'BBB', 'DDD']);
    const aaa = result.members.find((m) => m.symbol === 'AAA')!;
    expect(aaa.direction).toBe('GAINER');
    expect(aaa.screenerRank).toBe(2); // ranked by |eodMovePct| pre-screen: PNP2 (+50%) was rank 1 but penny-excluded
    expect(aaa.eodMovePct).toBeCloseTo(20, 6);
    expect(aaa.screenEvidence.spreadScreened).toBe(false); // honestly unavailable post-hoc
    expect(aaa.inTradableUniverse).toBe(true);
    const bbb = result.members.find((m) => m.symbol === 'BBB')!;
    expect(bbb.direction).toBe('LOSER');
  });

  it('marks the cohort insufficient when the provider throws - never a partial fabrication', async () => {
    const result = await buildMoverCohort('2026-10-06', {
      provider: fakeProvider({ throwOn: 'fetchRawMovers' }),
      screenConfig: TEST_CFG,
      nowMs: NOW_MS,
    });
    expect(result.insufficientEvidence).toBe(true);
    expect(result.members).toEqual([]);
    expect(result.insufficientReason).toMatch(/provider error/);
  });

  it('marks the cohort insufficient when the screener returns nothing usable', async () => {
    const result = await buildMoverCohort('2026-10-06', {
      provider: fakeProvider({ movers: { gainers: [], losers: [] }, universe: [] }),
      screenConfig: TEST_CFG,
      nowMs: NOW_MS,
    });
    expect(result.insufficientEvidence).toBe(true);
    expect(result.members).toEqual([]);
  });

  it('rejects a future trading date honestly', async () => {
    const result = await buildMoverCohort('2026-10-07', {
      provider: fakeProvider({}),
      screenConfig: TEST_CFG,
      nowMs: NOW_MS,
    });
    expect(result.insufficientEvidence).toBe(true);
    expect(result.insufficientReason).toMatch(/future/);
  });

  it('throws on a malformed trading date', async () => {
    await expect(buildMoverCohort('not-a-date', { provider: fakeProvider({}), screenConfig: TEST_CFG }))
      .rejects.toThrow(/invalid tradingDate/);
  });

  it('applyInvestableScreens mirrors the funnel gates (price/spread-crossed/spread/ADV)', () => {
    expect(applyInvestableScreens('X', undefined, 1_000_000, TEST_CFG)).toEqual({ pass: false, reason: 'NO_SNAPSHOT_DATA' });
    expect(applyInvestableScreens('X', snap('X', 2), 1_000_000, TEST_CFG).reason).toBe('PRICE');
    expect(applyInvestableScreens('X', { ...snap('X'), dollarVolume: 100 }, 1_000_000, TEST_CFG).reason).toBe('DOLLAR_VOLUME');
    expect(applyInvestableScreens('X', { ...snap('X'), spreadCrossed: true, spreadBps: -5 }, 1_000_000, TEST_CFG).reason).toBe('SPREAD_CROSSED');
    expect(applyInvestableScreens('X', { ...snap('X'), spreadBps: 500 }, 1_000_000, TEST_CFG).reason).toBe('SPREAD');
    expect(applyInvestableScreens('X', snap('X'), null, TEST_CFG).reason).toBe('ADV_DATA_UNAVAILABLE');
    expect(applyInvestableScreens('X', snap('X'), 100, TEST_CFG).reason).toBe('ADV_BELOW_FLOOR');
    expect(applyInvestableScreens('X', snap('X'), 1_000_000, TEST_CFG)).toEqual({ pass: true, reason: null });
  });

  it('defaultScreenConfig reads the same config keys the live funnel uses (mirror-drift guard)', () => {
    const cfg = defaultScreenConfig();
    expect(cfg.minPrice).toBe(continuousIntelligence.broadUniverseMinPrice);
    expect(cfg.maxPrice).toBe(continuousIntelligence.broadUniverseMaxPrice);
    expect(cfg.minDollarVolume).toBe(continuousIntelligence.broadUniverseMinDollarVolume);
    expect(cfg.maxSpreadBps).toBe(continuousIntelligence.broadUniverseMaxSpreadBps);
    expect(cfg.minAdvShares).toBe(continuousIntelligence.broadUniverseMinAvgDailyVolumeShares);
    expect(cfg.fetchTopNPerSide).toBe(continuousIntelligence.moversFetchTopNPerSide);
    expect(cfg.scanTopNPerSide).toBe(continuousIntelligence.moversTopNPerScan);
  });
});
