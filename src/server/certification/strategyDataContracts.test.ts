// LABEL: UNIT / COMPONENT
/**
 * ==========================================================
 * Test: certification/strategyDataContracts
 * Tier: UNIT / COMPONENT
 *
 * What this proves (and does not prove):
 *  - UNIT: the registry covers every known strategy id (coverage invariant), the
 *    getDataContract lookup behaves, and evaluateDataReadiness() maps availability
 *    descriptions to DATA_READY / PARTIALLY_READY / NOT_READY per the documented rules.
 *  - COMPONENT: the coverage invariant is checked against the real strategy inventory
 *    (CORE_STRATEGIES + EXPERIMENTAL_STRATEGIES imported from StrategyEngine), so a
 *    strategy added without a contract fails this suite.
 *  - It does NOT prove the contracts are correct against each strategy's evaluate() -
 *    that grounding lives in the per-strategy evidence comments in
 *    strategyDataContracts.ts, reviewed against the strategy sources. It does NOT prove
 *    readiness of any production data pipeline.
 *
 * All fixtures below are CERTIFICATION_FIXTURE_ONLY synthetic availability descriptions,
 * never organic evidence.
 * ==========================================================
 */
import { describe, it, expect } from 'vitest';
import { CORE_STRATEGIES, EXPERIMENTAL_STRATEGIES } from '../quant/strategies/StrategyEngine';
import {
  STRATEGY_DATA_CONTRACTS,
  getDataContract,
  evaluateDataReadiness,
  type AvailableData,
} from './strategyDataContracts';

const ALL_KNOWN_STRATEGIES = [...CORE_STRATEGIES, ...EXPERIMENTAL_STRATEGIES];

/** Full data: everything a strategy could need is present. */
const FULL_DATA: AvailableData = {
  intradayBars: true,
  dailyBars: 250,
  sessionVWAP: true,
  priorDayLevels: true,
  rvol: true,
  sectorData: true,
  relativeStrengthVsSpy: true,
};

/** Daily bars only: no intraday bars, no genuine session VWAP, plenty of daily history. */
const DAILY_BARS_ONLY: AvailableData = {
  intradayBars: false,
  dailyBars: 250,
  sessionVWAP: false,
  priorDayLevels: true,
  rvol: true,
  sectorData: true,
  relativeStrengthVsSpy: true,
};

function readinessFor(available: AvailableData, strategyId: string) {
  const entry = evaluateDataReadiness(available).find(r => r.strategyId === strategyId);
  expect(entry, `no readiness entry for ${strategyId}`).toBeDefined();
  return entry!;
}

describe('strategy data contracts - coverage invariant', () => {
  it('covers all 21 known strategies (5 core + 16 experimental)', () => {
    expect(ALL_KNOWN_STRATEGIES).toHaveLength(21);
    for (const strategy of ALL_KNOWN_STRATEGIES) {
      expect(
        STRATEGY_DATA_CONTRACTS[strategy.id],
        `strategy ${strategy.id} has no data contract - add one in strategyDataContracts.ts`,
      ).toBeDefined();
    }
  });

  it('contains no orphan contracts for unknown strategy ids', () => {
    const knownIds = new Set(ALL_KNOWN_STRATEGIES.map(s => s.id));
    for (const id of Object.keys(STRATEGY_DATA_CONTRACTS)) {
      expect(knownIds.has(id), `orphan contract for unknown strategy id ${id}`).toBe(true);
    }
  });

  it('every contract has a positive minDailyBars', () => {
    for (const [id, contract] of Object.entries(STRATEGY_DATA_CONTRACTS)) {
      expect(contract.minDailyBars, `${id}.minDailyBars`).toBeGreaterThan(0);
    }
  });
});

describe('strategy data contracts - highest-risk spot checks', () => {
  it('OPENING_RANGE_BREAKOUT requires intradayBars', () => {
    expect(getDataContract('OPENING_RANGE_BREAKOUT')?.intradayBars).toBe('REQUIRED');
  });

  it('OPENING_RANGE_BREAKOUT requires a genuine session VWAP', () => {
    expect(getDataContract('OPENING_RANGE_BREAKOUT')?.sessionVWAP).toBe('REQUIRED');
  });

  it('VWAP strategies require sessionVWAP=REQUIRED', () => {
    expect(getDataContract('VWAP_VOLUME_STRUCTURE')?.sessionVWAP).toBe('REQUIRED');
    expect(getDataContract('VWAP_MEAN_REVERSION')?.sessionVWAP).toBe('REQUIRED');
  });

  it('VWAP strategies require intradayBars (genuine VWAP needs real intraday bars)', () => {
    expect(getDataContract('VWAP_VOLUME_STRUCTURE')?.intradayBars).toBe('REQUIRED');
    expect(getDataContract('VWAP_MEAN_REVERSION')?.intradayBars).toBe('REQUIRED');
  });

  it('PREVIOUS_PERIOD_BREAKOUT requires priorDayLevels', () => {
    expect(getDataContract('PREVIOUS_PERIOD_BREAKOUT')?.priorDayLevels).toBe('REQUIRED');
  });

  it('VOLUME_CONFIRMATION requires rvol (the spike IS its trigger)', () => {
    expect(getDataContract('VOLUME_CONFIRMATION')?.rvol).toBe('REQUIRED');
  });

  it('RELATIVE_STRENGTH_ROTATION requires relativeStrengthVsSpy', () => {
    expect(getDataContract('RELATIVE_STRENGTH_ROTATION')?.relativeStrengthVsSpy).toBe('REQUIRED');
  });

  it('getDataContract returns undefined for an unknown strategy id', () => {
    expect(getDataContract('NO_SUCH_STRATEGY')).toBeUndefined();
  });
});

describe('evaluateDataReadiness', () => {
  it('with only daily bars, OPENING_RANGE_BREAKOUT is NOT_READY (never silently operational)', () => {
    const r = readinessFor(DAILY_BARS_ONLY, 'OPENING_RANGE_BREAKOUT');
    expect(r.readiness).toBe('NOT_READY');
    expect(r.missingRequired).toContain('intradayBars');
    expect(r.missingRequired).toContain('sessionVWAP');
  });

  it('with full intraday data, OPENING_RANGE_BREAKOUT is DATA_READY', () => {
    const r = readinessFor(FULL_DATA, 'OPENING_RANGE_BREAKOUT');
    expect(r.readiness).toBe('DATA_READY');
    expect(r.missingRequired).toEqual([]);
    expect(r.missingOptional).toEqual([]);
  });

  it('daily-only bars make both VWAP strategies NOT_READY', () => {
    for (const id of ['VWAP_VOLUME_STRUCTURE', 'VWAP_MEAN_REVERSION']) {
      const r = readinessFor(DAILY_BARS_ONLY, id);
      expect(r.readiness).toBe('NOT_READY');
      expect(r.missingRequired).toContain('sessionVWAP');
    }
  });

  it('daily-only bars leave purely daily strategies DATA_READY', () => {
    // TREND_FOLLOWING needs nothing but daily history (SMA200 needs 200 bars).
    const r = readinessFor(DAILY_BARS_ONLY, 'TREND_FOLLOWING');
    expect(r.readiness).toBe('DATA_READY');
  });

  it('missing a REQUIRED input is NOT_READY and names the input', () => {
    const r = readinessFor({ ...FULL_DATA, relativeStrengthVsSpy: false }, 'RELATIVE_STRENGTH_ROTATION');
    expect(r.readiness).toBe('NOT_READY');
    expect(r.missingRequired).toEqual(['relativeStrengthVsSpy']);
  });

  it('missing only OPTIONAL inputs is PARTIALLY_READY and names them', () => {
    // MOMENTUM_BREAKOUT: sectorData and relativeStrengthVsSpy are OPTIONAL confirmations.
    const r = readinessFor(
      { ...FULL_DATA, sectorData: false, relativeStrengthVsSpy: false },
      'MOMENTUM_BREAKOUT',
    );
    expect(r.readiness).toBe('PARTIALLY_READY');
    expect(r.missingRequired).toEqual([]);
    expect(r.missingOptional).toContain('sectorData');
    expect(r.missingOptional).toContain('relativeStrengthVsSpy');
  });

  it('insufficient daily history is NOT_READY via minDailyBars', () => {
    // MA_CROSSOVER needs 200 daily bars for the SMA200 stack.
    const r = readinessFor({ ...FULL_DATA, dailyBars: 60 }, 'MA_CROSSOVER');
    expect(r.readiness).toBe('NOT_READY');
    expect(r.missingRequired).toContain('minDailyBars');
  });

  it('sufficient daily history clears minDailyBars', () => {
    const r = readinessFor({ ...FULL_DATA, dailyBars: 200 }, 'MA_CROSSOVER');
    expect(r.readiness).toBe('DATA_READY');
  });

  it('returns one entry per contracted strategy', () => {
    const results = evaluateDataReadiness(FULL_DATA);
    expect(results).toHaveLength(Object.keys(STRATEGY_DATA_CONTRACTS).length);
    const ids = new Set(results.map(r => r.strategyId));
    expect(ids.size).toBe(results.length);
  });

  it('with full data every strategy is DATA_READY', () => {
    for (const r of evaluateDataReadiness(FULL_DATA)) {
      expect(r.readiness).toBe('DATA_READY');
    }
  });
});
