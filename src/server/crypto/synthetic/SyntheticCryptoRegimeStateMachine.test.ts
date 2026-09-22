import { describe, it, expect } from 'vitest';
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import { DEFAULT_TRANSITION_MATRIX, generateRegimePath, type SyntheticCryptoRegime } from './SyntheticCryptoRegimeStateMachine';

const REGIMES: readonly SyntheticCryptoRegime[] = [
  'TRENDING_BULL', 'TRENDING_BEAR', 'RANGE', 'VOLATILITY_EXPANSION', 'VOLATILITY_COMPRESSION', 'CRASH', 'RECOVERY',
];

describe('DEFAULT_TRANSITION_MATRIX', () => {
  it('every row sums to 1 (a valid probability distribution over next-regime)', () => {
    for (const from of REGIMES) {
      const row = DEFAULT_TRANSITION_MATRIX[from];
      const sum = REGIMES.reduce((acc, to) => acc + row[to], 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it('every probability is non-negative', () => {
    for (const from of REGIMES) {
      for (const to of REGIMES) {
        expect(DEFAULT_TRANSITION_MATRIX[from][to]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('generateRegimePath', () => {
  it('is deterministic given the same seed', () => {
    const a = generateRegimePath(new SyntheticRandom(555), 500, 'RANGE');
    const b = generateRegimePath(new SyntheticRandom(555), 500, 'RANGE');
    expect(a).toEqual(b);
  });

  it('a different seed produces a different path', () => {
    const a = generateRegimePath(new SyntheticRandom(1), 500, 'RANGE');
    const b = generateRegimePath(new SyntheticRandom(2), 500, 'RANGE');
    expect(a).not.toEqual(b);
  });

  it('starts at the requested initial regime', () => {
    const path = generateRegimePath(new SyntheticRandom(9), 100, 'TRENDING_BULL');
    expect(path[0]).toBe('TRENDING_BULL');
  });

  it('produces the exact requested length', () => {
    const path = generateRegimePath(new SyntheticRandom(9), 733, 'RANGE');
    expect(path).toHaveLength(733);
  });

  it('is not simply constant - a long enough path visits more than one regime under a chain with real transition mass', () => {
    const path = generateRegimePath(new SyntheticRandom(9), 2000, 'RANGE');
    const distinct = new Set(path);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('exhibits real persistence - the same regime tends to repeat on consecutive bars rather than flipping every bar (a Markov chain, not per-bar i.i.d. labeling)', () => {
    const path = generateRegimePath(new SyntheticRandom(2026), 5000, 'RANGE');
    let sameAsNext = 0;
    for (let i = 0; i < path.length - 1; i++) {
      if (path[i] === path[i + 1]) sameAsNext++;
    }
    const persistenceRate = sameAsNext / (path.length - 1);
    // Every diagonal entry in the matrix is well above 1/7 (uniform-random chance) - persistence
    // should be clearly dominant, not coincidental.
    expect(persistenceRate).toBeGreaterThan(0.5);
  });

  it('each bar only depends on the previous bar and the RNG stream - changing a hypothetical future draw cannot affect an earlier bar (causal by construction, verified by truncation equivalence)', () => {
    const full = generateRegimePath(new SyntheticRandom(4242), 200, 'RANGE');
    const truncated = generateRegimePath(new SyntheticRandom(4242), 100, 'RANGE');
    expect(truncated).toEqual(full.slice(0, 100));
  });
});
