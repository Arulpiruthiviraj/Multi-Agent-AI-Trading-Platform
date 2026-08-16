import { fractionalKelly, MIN_SAMPLE_SIZE_FOR_KELLY } from '../quant/risk/ExpectedValue';

export function researchKelly(winProbability: number, rrRatio: number, sampleSize: number) {
  const k = fractionalKelly(winProbability, rrRatio, sampleSize);
  if (!k.statisticallyJustified) {
    return { ...k, label: 'KELLY_UNAVAILABLE' as const, usedByRiskEngine: false };
  }
  return { ...k, label: 'RESEARCH_ONLY' as const, usedByRiskEngine: false };
}

export { MIN_SAMPLE_SIZE_FOR_KELLY };
