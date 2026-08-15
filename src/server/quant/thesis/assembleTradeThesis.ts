/**
 * Additive TradeThesis: structured why-buy / why-not-buy assembled from existing engines.
 * LLMs must not fill numeric fields. Default live path still does not execute from this object.
 */
import { StrategyContext, StrategyEvaluation } from '../strategies/types';
import { noTradeReasonsConfig, NoTradeReason } from '../../config/noTradeReasons';

export interface TradeThesis {
  schemaVersion: 1;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NO_TRADE';
  setup: string | null;
  marketRegime: string | null;
  supportingFactors: string[];
  contradictingFactors: string[];
  missingEvidence: string[];
  invalidationConditions: string[];
  entry: number | null;
  stop: number | null;
  target: number | null;
  expectedRewardRisk: number | null;
  estimatedExpectedValue: number | null;
  confidence: number | null;
  numericEvidenceSource: 'quant_engines';
  finalDecision: 'CANDIDATE' | 'NO_TRADE';
  noTrade: NoTradeReason | null;
  dataTimestamp: string;
}

function rr(entry: number | null, stop: number | null, target: number | null): number | null {
  if (entry === null || stop === null || target === null) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk === 0) return null;
  return reward / risk;
}

export function assembleTradeThesis(input: {
  symbol: string;
  ctx: StrategyContext;
  evaluation: StrategyEvaluation | null;
  ideaSide: 'BUY' | 'SELL' | 'HOLD';
  expectedValueR?: number | null;
}): TradeThesis {
  const { symbol, ctx, evaluation, ideaSide } = input;
  const missing: string[] = [];
  if (ctx.marketContext.breadth?.available === false) {
    missing.push(ctx.marketContext.breadth.reason);
  }
  if (ctx.volume.relativeVolume === null) missing.push('RVOL unavailable');
  if (ctx.volume.vwap.vwap === null) missing.push('Session VWAP unavailable');

  if (ideaSide === 'HOLD' || !evaluation) {
    const reason = noTradeReasonsConfig.reasons[0];
    return {
      schemaVersion: 1,
      symbol,
      direction: 'NO_TRADE',
      setup: evaluation?.strategy ?? null,
      marketRegime: ctx.regime.regime,
      supportingFactors: evaluation?.conditionsMet ?? [],
      contradictingFactors: evaluation?.contradictions ?? [],
      missingEvidence: missing,
      invalidationConditions: evaluation?.invalidationConditions ?? [],
      entry: ctx.currentPrice,
      stop: evaluation?.stop.price ?? null,
      target: evaluation?.target.price ?? null,
      expectedRewardRisk: null,
      estimatedExpectedValue: input.expectedValueR ?? null,
      confidence: evaluation?.confidence ?? null,
      numericEvidenceSource: 'quant_engines',
      finalDecision: 'NO_TRADE',
      noTrade: reason,
      dataTimestamp: new Date().toISOString(),
    };
  }

  const entry = ctx.currentPrice;
  const stop = evaluation.stop.price;
  const target = evaluation.target.price;
  return {
    schemaVersion: 1,
    symbol,
    direction: ideaSide === 'SELL' ? 'SHORT' : 'LONG',
    setup: evaluation.strategy,
    marketRegime: ctx.regime.regime,
    supportingFactors: evaluation.conditionsMet,
    contradictingFactors: [...evaluation.contradictions, ...evaluation.conditionsFailed.map(c => `Unmet: ${c}`)],
    missingEvidence: missing,
    invalidationConditions: evaluation.invalidationConditions,
    entry,
    stop,
    target,
    expectedRewardRisk: rr(entry, stop, target),
    estimatedExpectedValue: input.expectedValueR ?? null,
    confidence: evaluation.confidence,
    numericEvidenceSource: 'quant_engines',
    finalDecision: 'CANDIDATE',
    noTrade: null,
    dataTimestamp: new Date().toISOString(),
  };
}
