import { tradingSafety } from '../config/tradingSafety';

export function agentWeightUpdate(opts: {
  totalEvaluated: number;
  winRate: number;
}): { currentWeight: number; sharpeRatio: number; statisticallyMeaningful: boolean } {
  const min = tradingSafety.minSampleSizeForTrust;
  if (opts.totalEvaluated < min) {
    return { currentWeight: 1.0, sharpeRatio: 0, statisticallyMeaningful: false };
  }
  const currentWeight = Math.max(0.1, 1.0 + ((opts.winRate - 0.5) * 2));
  return { currentWeight, sharpeRatio: 0, statisticallyMeaningful: true };
}
