/**
 * Synthetic Market Session Simulator (2026-09-14 mandate), Phase 6: deterministic seeded PRNG.
 * mulberry32 - small, fast, well-distributed enough for synthetic price-path generation, and
 * critically: given the same numeric seed, produces the exact same sequence forever (no
 * platform-dependent Math.random()). This is what makes a simulationId+seed reproducible.
 */
export class SyntheticRandom {
  private state: number;

  constructor(seed: number) {
    // Fold the seed through a cheap mixing step so small/sequential seeds (1, 2, 3...) still
    // produce well-distributed initial state rather than a visibly correlated first few draws.
    this.state = (seed ^ 0x9e3779b9) >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  intRange(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Standard normal via Box-Muller - used for return-shock generation (price paths are built from
   *  log-returns, not raw uniform noise, so the resulting path looks like a real asset price, not
   *  a sawtooth). */
  gaussian(): number {
    const u1 = Math.max(this.next(), Number.EPSILON);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** True with probability p (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Picks one element uniformly at random. */
  pick<T>(items: readonly T[]): T {
    return items[this.intRange(0, items.length - 1)];
  }
}
