/**
 * ==========================================================
 * Module: quant/thesis/assembleTradeThesis
 *
 * Purpose:
 * Build a structured TradeThesis from engines that already ran (StrategyContext + one
 * StrategyEvaluation). This is the "why buy / why not buy" object for journals and UI.
 *
 * Hard rules:
 *   - Numeric facts (price, stop, target, R:R, EV) come from Quant / strategy modules only.
 *   - LLMs must not populate those fields (see parseResearchNote.ts).
 *   - A TradeThesis is NOT an order. ChiefTrader + RiskEngine still authorize execution.
 *   - HOLD or a missing evaluation is a first-class NO_TRADE (config/noTradeReasons.json),
 *     not an error.
 *
 * Wired today:
 *   QuantSignalAgent attaches the object as quantDetail.tradeThesis (additive). Approval
 *   math is unchanged.
 * ==========================================================
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
  /** Always quant_engines — documents that numbers were not LLM-invented. */
  numericEvidenceSource: 'quant_engines';
  finalDecision: 'CANDIDATE' | 'NO_TRADE';
  noTrade: NoTradeReason | null;
  dataTimestamp: string;
}

/** Reward/risk from engine prices. Null when any leg is missing or risk is zero (undefined ratio). */
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
  // Honest gaps already reported by MarketContext / volume engines — never filled with 0.
  if (ctx.marketContext.breadth?.available === false) {
    missing.push(ctx.marketContext.breadth.reason);
  }
  if (ctx.volume.relativeVolume === null) missing.push('RVOL unavailable');
  if (ctx.volume.vwap.vwap === null) missing.push('Session VWAP unavailable');

  if (ideaSide === 'HOLD' || !evaluation) {
    // reasons[0] is the configured default (INSUFFICIENT_EVIDENCE in noTradeReasons.json).
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
