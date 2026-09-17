import { describe, it, expect } from 'vitest';
import { SyntheticRandom } from './SyntheticRandom';
import { SyntheticMarketDataEngine, defaultSyntheticUniverse } from './SyntheticMarketDataEngine';
import { QUIET_OPEN, TRENDING_BULL_GAP_AND_GO, NEWS_SHOCK, EXTREME_NOISE, TRENDING_BEAR, SIDEWAYS, HIGH_VOLATILITY_OPEN, getScenario } from './SyntheticScenario';

const START = new Date('2026-09-15T13:30:00.000Z').getTime(); // 09:30 ET
const END = START + 90 * 60_000;

describe('SyntheticRandom (deterministic seeded PRNG)', () => {
  it('the same seed produces the exact same sequence', () => {
    const a = new SyntheticRandom(12345);
    const b = new SyntheticRandom(12345);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different sequences', () => {
    const a = new SyntheticRandom(1);
    const b = new SyntheticRandom(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('next() stays within [0, 1)', () => {
    const rng = new SyntheticRandom(999);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('SyntheticMarketDataEngine (deterministic dynamic bar generation)', () => {
  it('the same seed + scenario produces byte-identical bars - reproducibility for debugging/regression', () => {
    const universe = defaultSyntheticUniverse(3);
    const engineA = new SyntheticMarketDataEngine(new SyntheticRandom(42), universe, QUIET_OPEN);
    const engineB = new SyntheticMarketDataEngine(new SyntheticRandom(42), universe, QUIET_OPEN);
    const sessionA = engineA.generateSession(START, END);
    const sessionB = engineB.generateSession(START, END);
    expect(Object.fromEntries(sessionA)).toEqual(Object.fromEntries(sessionB));
  });

  it('different seeds produce different price paths for the same scenario', () => {
    const universe = defaultSyntheticUniverse(1);
    const engineA = new SyntheticMarketDataEngine(new SyntheticRandom(1), universe, QUIET_OPEN);
    const engineB = new SyntheticMarketDataEngine(new SyntheticRandom(2), universe, QUIET_OPEN);
    const barsA = engineA.generateSession(START, END).get('SPY')!;
    const barsB = engineB.generateSession(START, END).get('SPY')!;
    expect(barsA.map((b) => b.close)).not.toEqual(barsB.map((b) => b.close));
  });

  it('does not simply replay the same candle repeatedly - real successive-bar variation', () => {
    const universe = defaultSyntheticUniverse(1);
    const engine = new SyntheticMarketDataEngine(new SyntheticRandom(7), universe, TRENDING_BULL_GAP_AND_GO);
    const bars = engine.generateSession(START, END).get('SPY')!;
    const uniqueCloses = new Set(bars.map((b) => b.close));
    expect(uniqueCloses.size).toBeGreaterThan(bars.length * 0.9); // near-all distinct, not a repeated loop
  });

  it('produces real OHLC ordering (high >= max(open,close), low <= min(open,close)) for every bar', () => {
    const universe = defaultSyntheticUniverse(2);
    const engine = new SyntheticMarketDataEngine(new SyntheticRandom(55), universe, NEWS_SHOCK);
    for (const bars of engine.generateSession(START, END).values()) {
      for (const bar of bars) {
        expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
        expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
        expect(bar.ask).toBeGreaterThan(bar.bid);
        expect(bar.volume).toBeGreaterThan(0);
      }
    }
  });

  it('QUIET_OPEN produces small net drift and no gap - a legitimately low-opportunity session', () => {
    const universe = defaultSyntheticUniverse(1);
    const engine = new SyntheticMarketDataEngine(new SyntheticRandom(101), universe, QUIET_OPEN);
    const bars = engine.generateSession(START, END).get('SPY')!;
    const first = bars[0];
    const last = bars[bars.length - 1];
    const netMovePct = Math.abs(last.close - first.open) / first.open;
    expect(netMovePct).toBeLessThan(0.03); // well within normal single-session noise, no persistent trend
    expect(Math.abs(first.open - defaultSyntheticUniverse(1)[0].startPrice) / defaultSyntheticUniverse(1)[0].startPrice).toBeLessThan(0.001); // no gap at open
  });

  it('TRENDING_BULL_GAP_AND_GO produces a real opening gap and a sustained positive net move', () => {
    const universe = defaultSyntheticUniverse(1);
    const engine = new SyntheticMarketDataEngine(new SyntheticRandom(202), universe, TRENDING_BULL_GAP_AND_GO);
    const bars = engine.generateSession(START, END).get('SPY')!;
    const startPrice = defaultSyntheticUniverse(1)[0].startPrice;
    const gapPct = (bars[0].open - startPrice) / startPrice;
    expect(gapPct).toBeGreaterThan(0.01); // real gap up, matches the scenario's configured 1.8%
    const netMovePct = (bars[bars.length - 1].close - bars[0].open) / bars[0].open;
    expect(netMovePct).toBeGreaterThan(0.005); // sustained continuation, not just the gap alone
  });

  it('NEWS_SHOCK produces a deterministic price gap exactly at the configured offset, not before', () => {
    const universe = defaultSyntheticUniverse(1);
    const engine = new SyntheticMarketDataEngine(new SyntheticRandom(303), universe, NEWS_SHOCK);
    const bars = engine.generateSession(START, END).get('SPY')!;
    const shockBarIndex = 20; // NEWS_SHOCK event fires at atOffsetMs = 20 * MIN
    // The shock is applied as a direct multiplicative jump to `price` BEFORE that bar's own
    // open/close are computed - i.e. a gap between the prior bar's close and the shock bar's open,
    // the same mechanic as a GAP event. This is deterministic (not one random gaussian draw), so
    // asserting on it directly (rather than the shock bar's own open->close move, which is still
    // just one noisy draw and can legitimately be small by chance) is the correct, non-flaky check.
    const priorClose = bars[shockBarIndex - 1].close;
    const shockBarOpen = bars[shockBarIndex].open;
    const gapPct = Math.abs(shockBarOpen - priorClose) / priorClose;
    expect(gapPct).toBeGreaterThan(0.01); // matches HIGH_IMPACT's configured 2% jump, well above normal per-bar noise

    // And nothing analogous happens on any earlier bar-to-bar transition.
    for (let i = 1; i < shockBarIndex; i++) {
      const stepPct = Math.abs(bars[i].open - bars[i - 1].close) / bars[i - 1].close;
      expect(stepPct).toBeLessThan(gapPct);
    }
  });

  it('EXTREME_NOISE has zero configured drift - any net move is randomness, not manufactured direction', () => {
    // Directly assert on the scenario config itself, which is what actually drives the pipeline's
    // behavior - the strongest, most direct proof this scenario cannot manufacture a trend.
    expect(EXTREME_NOISE.segments.every((s) => s.driftPerBarMean === 0)).toBe(true);
    expect(EXTREME_NOISE.expectedToBeTradeable).toBe(false);
  });

  it('defaultSyntheticUniverse(n) returns exactly n distinct, real-looking symbols, bounded to the known list', () => {
    expect(defaultSyntheticUniverse(5)).toHaveLength(5);
    expect(defaultSyntheticUniverse(3).map((s) => s.symbol)).toEqual(['SPY', 'QQQ', 'AAPL']);
    expect(defaultSyntheticUniverse(999).length).toBeLessThanOrEqual(10); // capped, does not fabricate extra symbols
  });
});

/**
 * 2026-09-16 synthetic-coverage follow-up: three new scenario profiles (TRENDING_BEAR, SIDEWAYS,
 * HIGH_VOLATILITY_OPEN) added to close real, disclosed gaps found by the same-day coverage audit
 * (docs/audits/ARGUS_SYNTHETIC_COVERAGE_AND_TODAY_REVERSE_ENGINEERING_2026-09-16.md - "6 of ~70
 * named scenarios" had dedicated implementations). This suite proves structural correctness
 * (registry resolution, valid segments, deterministic and internally-consistent generated bars) -
 * the same tier of proof SyntheticMarketDataEngine's own existing tests above establish for
 * QUIET_OPEN/TRENDING_BULL_GAP_AND_GO/etc. It does NOT run a full multi-agent
 * SyntheticSessionEngine pass (real ChiefTrader/RiskEngine/OMS observation) - that is a materially
 * larger, separate undertaking honestly left as remaining backlog, not claimed here.
 */
describe('New scenario profiles (2026-09-16 coverage follow-up): TRENDING_BEAR / SIDEWAYS / HIGH_VOLATILITY_OPEN', () => {
  it('all three resolve via the real scenario registry (getScenario), not just as standalone exports', () => {
    expect(getScenario('TRENDING_BEAR')).toBe(TRENDING_BEAR);
    expect(getScenario('SIDEWAYS')).toBe(SIDEWAYS);
    expect(getScenario('HIGH_VOLATILITY_OPEN')).toBe(HIGH_VOLATILITY_OPEN);
  });

  it('every segment across all three scenarios is chronologically ordered and non-overlapping', () => {
    for (const scenario of [TRENDING_BEAR, SIDEWAYS, HIGH_VOLATILITY_OPEN]) {
      for (let i = 1; i < scenario.segments.length; i++) {
        expect(scenario.segments[i].fromOffsetMs).toBe(scenario.segments[i - 1].toOffsetMs);
        expect(scenario.segments[i].toOffsetMs).toBeGreaterThan(scenario.segments[i].fromOffsetMs);
      }
    }
  });

  it('TRENDING_BEAR: same seed produces byte-identical bars (determinism, same guarantee as every other scenario)', () => {
    const universe = defaultSyntheticUniverse(2);
    const engineA = new SyntheticMarketDataEngine(new SyntheticRandom(2026), universe, TRENDING_BEAR);
    const engineB = new SyntheticMarketDataEngine(new SyntheticRandom(2026), universe, TRENDING_BEAR);
    expect(Object.fromEntries(engineA.generateSession(START, END))).toEqual(Object.fromEntries(engineB.generateSession(START, END)));
  });

  it('TRENDING_BEAR: real net negative drift over the session - the short-side mirror actually moves down, not just configured to', () => {
    const universe = defaultSyntheticUniverse(1);
    const engine = new SyntheticMarketDataEngine(new SyntheticRandom(11), universe, TRENDING_BEAR);
    const bars = engine.generateSession(START, END).get('SPY')!;
    expect(bars[bars.length - 1].close).toBeLessThan(bars[0].open);
  });

  it('SIDEWAYS: net move stays much smaller than TRENDING_BEAR/TRENDING_BULL_GAP_AND_GO over the same window - a real range, not a hidden trend', () => {
    const universe = defaultSyntheticUniverse(1);
    const sidewaysBars = new SyntheticMarketDataEngine(new SyntheticRandom(33), universe, SIDEWAYS).generateSession(START, END).get('SPY')!;
    const bearBars = new SyntheticMarketDataEngine(new SyntheticRandom(33), universe, TRENDING_BEAR).generateSession(START, END).get('SPY')!;
    const sidewaysNetMovePct = Math.abs(sidewaysBars[sidewaysBars.length - 1].close - sidewaysBars[0].open) / sidewaysBars[0].open;
    const bearNetMovePct = Math.abs(bearBars[bearBars.length - 1].close - bearBars[0].open) / bearBars[0].open;
    expect(sidewaysNetMovePct).toBeLessThan(bearNetMovePct);
  });

  it('HIGH_VOLATILITY_OPEN: produces real, valid OHLC ordering under elevated volatility (no NaN/negative price from the higher volatilityMultiplier)', () => {
    const universe = defaultSyntheticUniverse(3);
    const engine = new SyntheticMarketDataEngine(new SyntheticRandom(77), universe, HIGH_VOLATILITY_OPEN);
    for (const bars of engine.generateSession(START, END).values()) {
      for (const bar of bars) {
        expect(Number.isFinite(bar.close)).toBe(true);
        expect(bar.close).toBeGreaterThan(0);
        expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
        expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      }
    }
  });

  it('HIGH_VOLATILITY_OPEN: genuinely higher bar-to-bar variance than QUIET_OPEN, proving the volatilityMultiplier actually takes effect', () => {
    const universe = defaultSyntheticUniverse(1);
    const quietBars = new SyntheticMarketDataEngine(new SyntheticRandom(5), universe, QUIET_OPEN).generateSession(START, END).get('SPY')!;
    const volatileBars = new SyntheticMarketDataEngine(new SyntheticRandom(5), universe, HIGH_VOLATILITY_OPEN).generateSession(START, END).get('SPY')!;
    const stepStddev = (bars: typeof quietBars) => {
      const steps = bars.slice(1).map((b, i) => (b.close - bars[i].close) / bars[i].close);
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      const variance = steps.reduce((a, b) => a + (b - mean) ** 2, 0) / steps.length;
      return Math.sqrt(variance);
    };
    expect(stepStddev(volatileBars)).toBeGreaterThan(stepStddev(quietBars));
  });
});
