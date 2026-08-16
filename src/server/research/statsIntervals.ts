/** Wilson score interval for a binomial win rate. Not a calibrated LLM probability. */

export function wilsonInterval(wins: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0 || wins < 0 || wins > n) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { low: (center - margin) / denom, high: (center + margin) / denom };
}

export type ProbabilityKind = 'MODEL_ESTIMATE' | 'EMPIRICALLY_VALIDATED' | 'UNAVAILABLE';

export function classifyProbability(sampleSize: number, minSample: number, source: 'llm' | 'empirical' | 'none'): ProbabilityKind {
  if (source === 'none' || sampleSize <= 0) return 'UNAVAILABLE';
  if (source === 'llm') return 'MODEL_ESTIMATE';
  if (sampleSize >= minSample) return 'EMPIRICALLY_VALIDATED';
  return 'UNAVAILABLE';
}
