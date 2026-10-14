// LABEL: SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY - runs the REAL MarketUniverseScanner against the hidden-truth synthetic market through the guarded provider seam.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { installSyntheticAlpacaProvider, getBlockedSyntheticAlpacaCalls, resetBlockedSyntheticAlpacaCalls } from '../core/alpacaTls';
import { SyntheticDiscoveryMarket, SESSION_MINUTES } from '../replay/synthetic/discovery/SyntheticDiscoveryMarket';
import { createSyntheticAlpacaProvider } from '../replay/synthetic/discovery/SyntheticAlpacaProvider';
import {
  refreshBroadUniverseCache, refreshMoversCache, getCachedBroadUniverseCandidatesWithVolume, getCachedBroadUniverseGapPct,
  getCachedMoverSymbols, resetMarketUniverseScannerForTests,
} from './MarketUniverseScanner';

const OPEN_MS = Date.parse('2026-10-14T13:30:00.000Z');
const BROAD = continuousIntelligence.broadUniverseEnabledEnvVar;
const MOVERS = continuousIntelligence.moversEnabledEnvVar;

describe('real MarketUniverseScanner on the synthetic market (provider seam)', () => {
  let minute = 0;
  const market = new SyntheticDiscoveryMarket({ seed: 4242, universeSize: 300, startingWatchlistSize: 60, validCount: 12, trapCount: 8, outsideFraction: 1 });

  beforeEach(() => {
    minute = 0;
    process.env[BROAD] = 'true'; process.env[MOVERS] = 'true';
    resetMarketUniverseScannerForTests(); resetBlockedSyntheticAlpacaCalls();
    vi.spyOn(Date, 'now').mockImplementation(() => OPEN_MS + minute * 60_000);
    installSyntheticAlpacaProvider(createSyntheticAlpacaProvider(market, { minute: () => minute, nowMs: () => OPEN_MS + minute * 60_000 }).fetch);
  });
  afterEach(() => {
    installSyntheticAlpacaProvider(null); vi.restoreAllMocks(); delete process.env[BROAD]; delete process.env[MOVERS]; resetMarketUniverseScannerForTests();
  });

  it('screens the synthetic universe with the production rules: liquid names admitted, a thin trap INSIDE its spike window is rejected, evidence equals the published feed', async () => {
    const thin = market.groundTruth().filter((s) => s.cls === 'TRAP' && (s.kind === 'LOW_LIQUIDITY_SPIKE' || s.kind === 'TINY_VOLUME_HUGE_PCT'));
    expect(thin.length).toBeGreaterThan(0);
    minute = thin[0].startMin + 3; // inside the spike: the published quote is wide (140 bps > the 50 bps ceiling)
    const stats = await refreshBroadUniverseCache();
    expect(stats.error).toBeNull();
    expect(stats.assetsFetched).toBe(300);
    const admitted = getCachedBroadUniverseCandidatesWithVolume();
    expect(admitted.length).toBeGreaterThan(10);
    expect(admitted.some((c) => c.symbol === thin[0].symbol)).toBe(false);
    // the scanner's computed gap evidence is derived from the published snapshot (since-open return), not from hidden truth
    const probe = admitted[0].symbol;
    expect(getCachedBroadUniverseGapPct(probe)).toBeCloseTo(market.sessionMoveAt(probe, minute) as number, 3);
    expect(getBlockedSyntheticAlpacaCalls()).toEqual([]);
  }, 120_000);

  it('movers screen: the movers feed is built from published prices only and passes through the same liquidity gates', async () => {
    minute = 120;
    const stats = await refreshMoversCache();
    expect(stats.error).toBeNull();
    expect(stats.gainersFetched + stats.losersFetched).toBeGreaterThan(0);
    const movers = getCachedMoverSymbols();
    expect(movers.length).toBeGreaterThan(0);
    expect(getBlockedSyntheticAlpacaCalls()).toEqual([]);
  }, 120_000);

  it('with NO provider installed in a synthetic process, an Alpaca call is refused and recorded - never sent to the real network', async () => {
    installSyntheticAlpacaProvider(null);
    const prev = process.env.SYNTHETIC_SIMULATION; process.env.SYNTHETIC_SIMULATION = 'true';
    try {
      const { alpacaFetch } = await import('../core/alpacaTls');
      const res = await alpacaFetch('https://data.alpaca.markets/v2/stocks/snapshots?symbols=AAPL');
      expect(res.status).toBe(503);
      expect(getBlockedSyntheticAlpacaCalls()).toHaveLength(1);
    } finally { if (prev === undefined) delete process.env.SYNTHETIC_SIMULATION; else process.env.SYNTHETIC_SIMULATION = prev; }
  });

  it('session length constant the harness relies on', () => { expect(SESSION_MINUTES).toBe(390); });
});
