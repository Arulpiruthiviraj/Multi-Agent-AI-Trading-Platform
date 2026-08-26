/**
 * Trade Setup Generation (Phase 11). Composes RegimeDetectionResearch + RiskRewardResearch +
 * MultiFactorResearch (+ optional CorrelationResearch) into one structured artifact. This is
 * explicitly NOT an approved trade and NEVER calls eventBus.emitTradeIdea, ChiefTraderAgent, or any
 * broker/OMS code — it has an `expiresAt` precisely so nothing downstream could ever mistake a
 * stale research artifact for a live decision. If this artifact is ever wired to become eligible
 * for paper execution in a future phase, it must re-enter Argus through the normal
 * emitTradeIdea -> ChiefTrader -> RiskEngine -> OMS pipeline like every other idea — that wiring
 * does not exist yet and is out of scope for this pass.
 */
import type { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { classifyRegime } from '../../quant/RegimeEngine';
import { runMultiFactorResearch } from './MultiFactorResearch';
import { riskRewardRatio } from '../../quant/risk/ExpectedValue';
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export interface TradeSetup {
  symbol: string;
  direction: 'BUY' | 'SELL' | 'NONE';
  entryZone: { low: number; high: number } | null;
  stop: number | null;
  target: number | null;
  riskReward: ReturnType<typeof riskRewardRatio>;
  supportingSignals: string[];
  regime: string;
  liquidityNote: string;
  confidence: number; // 0-1, transparent composite — NOT a ChiefTrader consensus confidence
  dataTimestamp: string;
  expiresAt: string;
  /** Load-bearing label — never remove or rename without checking every consumer. */
  status: 'RESEARCH_SETUP_NOT_AN_APPROVED_TRADE';
}

export function runTradeSetupResearch(opts: {
  symbol: string;
  bars: Bar[];
  stopDistancePct?: number;
  targetDistancePct?: number;
  expirySeconds?: number;
  traceId?: string;
}): ResearchResult<TradeSetup> {
  const regime = classifyRegime(opts.bars);
  const factorResult = runMultiFactorResearch({ symbol: opts.symbol, bars: opts.bars, traceId: opts.traceId });
  const currentPrice = opts.bars.length ? opts.bars[opts.bars.length - 1].close : NaN;
  const composite = factorResult.data.compositeScore;

  const direction: TradeSetup['direction'] = composite === null ? 'NONE' : composite > 0.15 ? 'BUY' : composite < -0.15 ? 'SELL' : 'NONE';
  const stopPct = opts.stopDistancePct ?? 0.02;
  const targetPct = opts.targetDistancePct ?? 0.04;

  let stop: number | null = null;
  let target: number | null = null;
  let riskReward: ReturnType<typeof riskRewardRatio> = null;
  if (direction !== 'NONE' && Number.isFinite(currentPrice)) {
    stop = direction === 'BUY' ? currentPrice * (1 - stopPct) : currentPrice * (1 + stopPct);
    target = direction === 'BUY' ? currentPrice * (1 + targetPct) : currentPrice * (1 - targetPct);
    riskReward = riskRewardRatio(currentPrice, stop, target);
  }

  const supportingSignals = factorResult.data.factors
    .filter((f) => f.score !== null && Math.abs(f.score) > 0.2)
    .map((f) => `${f.factor}=${f.score!.toFixed(2)}`);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + (opts.expirySeconds ?? 300) * 1000).toISOString();

  const data: TradeSetup = {
    symbol: opts.symbol,
    direction,
    entryZone: Number.isFinite(currentPrice) ? { low: currentPrice * 0.999, high: currentPrice * 1.001 } : null,
    stop,
    target,
    riskReward,
    supportingSignals,
    regime: regime.insufficientData ? 'INSUFFICIENT_DATA' : regime.regime,
    liquidityNote: factorResult.data.factors.find((f) => f.factor === 'liquidity')?.missing
      ? 'Liquidity factor unavailable — this setup should be treated as lower-confidence until it is.'
      : 'Liquidity factor computed from real relative-volume data.',
    confidence: composite === null ? 0 : Math.min(1, Math.abs(composite)),
    dataTimestamp: now.toISOString(),
    expiresAt,
    status: 'RESEARCH_SETUP_NOT_AN_APPROVED_TRADE',
  };

  const dataQuality: DataQualityMeta = {
    source: 'Composition of RegimeDetectionResearch + MultiFactorResearch + ExpectedValue.riskRewardRatio (all reused)',
    symbol: opts.symbol,
    timestamp: now.toISOString(),
    sampleSize: opts.bars.length,
    missingFields: direction === 'NONE' ? ['no factor combination cleared the direction threshold'] : [],
    staleness: 'FRESH',
    assumptions: [`stopDistancePct=${stopPct}`, `targetDistancePct=${targetPct}`, 'This is a RESEARCH artifact — it has never been submitted to ChiefTrader, RiskEngine, or any broker.'],
    quality: factorResult.dataQuality.quality,
  };

  const result = wrapResearchResult({ capability: 'TRADE_SETUP_GENERATION', label: 'ADVISORY', dataQuality, data });
  emitResearchEvent('TRADE_SETUP_GENERATED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.symbol,
    direction,
    expiresAt,
  });
  return result;
}
