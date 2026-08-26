/**
 * Risk/Reward Analysis (Phase 6). Reuses riskRewardRatio/expectedValue/fractionalKelly
 * (quant/risk/ExpectedValue.ts) and computeLiveStrategyWinRate (LiveStrategyPerformance.ts)
 * unchanged — this module adds only the one genuinely missing piece: historical maximum adverse/
 * favorable excursion (MAE/MFE) from a real bar series between an entry and exit index. Advisory
 * only; never writes to RiskEngine or PositionSizing.
 */
import type { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { riskRewardRatio, expectedValue, fractionalKelly, MIN_SAMPLE_SIZE_FOR_KELLY } from '../../quant/risk/ExpectedValue';
import { computeLiveStrategyWinRate } from '../../quant/risk/LiveStrategyPerformance';
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export interface ExcursionResult {
  maxAdverseExcursionPct: number | null;
  maxFavorableExcursionPct: number | null;
  barsHeld: number;
}

/** Real MAE/MFE from the actual bar-by-bar path between entry and exit — never estimated. */
export function computeExcursion(
  bars: Bar[],
  entryIndex: number,
  exitIndex: number,
  side: 'BUY' | 'SELL',
  entryPrice: number,
): ExcursionResult {
  if (entryIndex < 0 || exitIndex <= entryIndex || exitIndex >= bars.length || entryPrice <= 0) {
    return { maxAdverseExcursionPct: null, maxFavorableExcursionPct: null, barsHeld: 0 };
  }
  const path = bars.slice(entryIndex + 1, exitIndex + 1);
  let worst = 0; // most negative pct move against the position
  let best = 0; // most positive pct move in favor of the position
  for (const bar of path) {
    const lowMove = side === 'BUY' ? (bar.low - entryPrice) / entryPrice : (entryPrice - bar.high) / entryPrice;
    const highMove = side === 'BUY' ? (bar.high - entryPrice) / entryPrice : (entryPrice - bar.low) / entryPrice;
    worst = Math.min(worst, lowMove);
    best = Math.max(best, highMove);
  }
  return { maxAdverseExcursionPct: worst, maxFavorableExcursionPct: best, barsHeld: path.length };
}

export interface RiskRewardAnalysis {
  riskReward: ReturnType<typeof riskRewardRatio>;
  excursion: ExcursionResult | null;
  liveWinRate: Awaited<ReturnType<typeof computeLiveStrategyWinRate>>;
  expectedValueR: ReturnType<typeof expectedValue>;
  kelly: ReturnType<typeof fractionalKelly> | null;
}

export async function runRiskRewardResearch(opts: {
  symbol: string;
  strategyId?: string;
  entry: number;
  stop: number;
  target: number;
  side?: 'BUY' | 'SELL';
  bars?: Bar[];
  entryIndex?: number;
  exitIndex?: number;
  traceId?: string;
}): Promise<ResearchResult<RiskRewardAnalysis>> {
  const riskReward = riskRewardRatio(opts.entry, opts.stop, opts.target);
  const excursion = opts.bars && opts.entryIndex != null && opts.exitIndex != null && opts.side
    ? computeExcursion(opts.bars, opts.entryIndex, opts.exitIndex, opts.side, opts.entry)
    : null;
  const liveWinRate = opts.strategyId ? await computeLiveStrategyWinRate(opts.strategyId) : null;
  const expectedValueR = riskReward && liveWinRate ? expectedValue(liveWinRate.winProbability, riskReward.ratio!) : null;
  const kelly = liveWinRate && riskReward?.ratio
    ? fractionalKelly(liveWinRate.winProbability, riskReward.ratio, liveWinRate.sampleSize)
    : null;

  const missing: string[] = [];
  if (!riskReward) missing.push('riskReward (invalid entry/stop/target)');
  if (!liveWinRate) missing.push(`liveWinRate (no closed trades yet for ${opts.strategyId ?? 'unspecified strategy'})`);

  const dataQuality: DataQualityMeta = {
    source: 'ExpectedValue.ts + LiveStrategyPerformance.ts (reused, unchanged)',
    symbol: opts.symbol,
    timestamp: new Date().toISOString(),
    sampleSize: liveWinRate?.sampleSize ?? 0,
    missingFields: missing,
    staleness: 'FRESH',
    assumptions: [
      `Kelly/EV require >= ${MIN_SAMPLE_SIZE_FOR_KELLY} closed trades to be statistically trusted; below that, kelly/expectedValueR are null, not estimated.`,
    ],
    quality: riskReward && liveWinRate ? 'GREEN' : riskReward ? 'YELLOW' : 'UNAVAILABLE',
  };

  const data: RiskRewardAnalysis = { riskReward, excursion, liveWinRate, expectedValueR, kelly };
  const result = wrapResearchResult({ capability: 'RISK_REWARD_ANALYSIS', label: 'RESEARCH', dataQuality, data });
  emitResearchEvent('RISK_REWARD_ANALYSIS_COMPLETED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.symbol,
    expectedValueR: expectedValueR?.expectedValueR ?? null,
  });
  return result;
}
