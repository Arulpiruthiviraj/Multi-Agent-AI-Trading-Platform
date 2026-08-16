import { researchSafety } from '../config/researchSafety';
import { runSmaCrossover } from './smaCrossover';
import type { ResearchBar } from './ohlcvTypes';

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PermutationResult {
  observedMetric: number;
  pValue: number;
  percentile: number;
  nullMean: number;
  permutations: number;
  pass: boolean;
}

/** Trade-PnL sign permutation. Does not manufacture confidence. */
export function permutationTestPnls(pnls: number[], permutations = 200, seed = 42): PermutationResult {
  const observed = pnls.reduce((a, b) => a + b, 0);
  if (pnls.length === 0) {
    return { observedMetric: 0, pValue: 1, percentile: 0, nullMean: 0, permutations: 0, pass: false };
  }
  const rng = mulberry32(seed);
  let ge = 0;
  let nullSum = 0;
  for (let p = 0; p < permutations; p++) {
    let s = 0;
    for (const x of pnls) s += rng() < 0.5 ? -Math.abs(x) : Math.abs(x);
    nullSum += s;
    if (s >= observed) ge += 1;
  }
  const pValue = (ge + 1) / (permutations + 1);
  return {
    observedMetric: observed,
    pValue,
    percentile: 1 - pValue,
    nullMean: nullSum / permutations,
    permutations,
    pass: pValue <= researchSafety.permutationAlpha,
  };
}

export interface SensitivityResult {
  neighborhood: Array<{ fast: number; slow: number; netPnl: number; tradeCount: number }>;
  fragile: boolean;
}

export function sensitivityAround(bars: ResearchBar[], fast: number, slow: number, capital: number): SensitivityResult {
  const neighborhood: SensitivityResult['neighborhood'] = [];
  for (const df of [-1, 0, 1]) {
    for (const ds of [-1, 0, 1]) {
      const f = fast + df;
      const s = slow + ds;
      if (f < 2 || s <= f) continue;
      const r = runSmaCrossover(bars, f, s, capital);
      neighborhood.push({ fast: f, slow: s, netPnl: r.netPnl, tradeCount: r.tradeCount });
    }
  }
  const center = neighborhood.find((n) => n.fast === fast && n.slow === slow);
  const others = neighborhood.filter((n) => !(n.fast === fast && n.slow === slow));
  const profitableCenter = (center?.netPnl ?? 0) > 0;
  const anyNeighborProfitable = others.some((n) => n.netPnl > 0);
  const fragile = profitableCenter && !anyNeighborProfitable && others.length > 0;
  return { neighborhood, fragile };
}

export interface CostStressResult {
  multiples: Array<{ multiple: number; netPnl: number }>;
  costFragile: boolean;
}

export function costStress(bars: ResearchBar[], fast: number, slow: number, capital: number, baseCommission: number): CostStressResult {
  const multiples = [0, 1, 2, 3].map((multiple) => {
    const r = runSmaCrossover(bars, fast, slow, capital, baseCommission * multiple);
    return { multiple, netPnl: r.netPnl };
  });
  const atCap = multiples.find((m) => m.multiple === researchSafety.costStressMaxMultipleStillProfitable);
  const atZero = multiples.find((m) => m.multiple === 0);
  const costFragile = (atZero?.netPnl ?? 0) > 0 && (atCap?.netPnl ?? 0) <= 0;
  return { multiples, costFragile };
}
