/**
 * Additive evidence pack for ChiefTrader. Does not approve orders and does not replace consensus math.
 * Scores are 0–100 with an explicit source. Missing inputs are scored null + DATA UNAVAILABLE.
 */
import { deskIntelligence } from '../config/deskIntelligence';
import { tradingSafety } from '../config/tradingSafety';
import { noTradeReasonByCode } from '../config/noTradeReasons';
import type { DataQualitySnapshot } from '../core/dataQuality';
import type { RegimeResult } from '../quant/RegimeEngine';
import type { StrategyEvaluation } from '../quant/strategies/types';
import { scoreConfluence } from './ConfluenceEngine';
import { rankSetups } from './SetupEngine';

export interface SourcedScore {
  name: string;
  value: number | null;
  source: string;
  evidenceQuality: 'MEASURED' | 'UNAVAILABLE' | 'INSUFFICIENT_SAMPLE';
  note: string;
}

export interface EliteTraderDecision {
  schemaVersion: 1;
  disposition: 'BUY' | 'SELL' | 'HOLD' | 'WAIT' | 'WATCHLIST';
  waitReasonCode: string | null;
  waitReasonLabel: string | null;
  questions: Record<string, string>;
  scores: Record<string, SourcedScore>;
  setups: ReturnType<typeof rankSetups>;
  confluence: ReturnType<typeof scoreConfluence>;
}

function score(name: string, value: number | null, source: string, note: string, quality: SourcedScore['evidenceQuality'] = value === null ? 'UNAVAILABLE' : 'MEASURED'): SourcedScore {
  return { name, value, source, evidenceQuality: value === null ? 'UNAVAILABLE' : quality, note };
}

export function buildEliteTraderDecision(input: {
  symbol: string;
  regime?: RegimeResult | null;
  evaluation?: StrategyEvaluation | null;
  dataQuality?: DataQualitySnapshot | null;
  riskReward?: number | null;
  expectedValueR?: number | null;
  evSampleSize?: number | null;
  catalystContribution?: number | null;
  relativeStrengthVsSpy?: number | null;
  vwapDistancePct?: number | null;
  contradictions?: string[];
  newsEmitsTradeIdeas?: boolean;
}): EliteTraderDecision {
  const evaln = input.evaluation ?? null;
  const regime = input.regime ?? null;
  const dq = input.dataQuality ?? null;
  const setups = rankSetups({ evaluation: evaln, regime, catalystContribution: input.catalystContribution ?? null, relativeStrengthVsSpy: input.relativeStrengthVsSpy ?? null, vwapDistancePct: input.vwapDistancePct ?? null });
  const confluence = scoreConfluence({
    hasStructure: !!evaln && evaln.setupScore >= 50,
    hasVolume: (evaln?.conditionsMet || []).some((c) => /volume|rvol|vwap/i.test(c)),
    hasVwap: typeof input.vwapDistancePct === 'number',
    hasIndex: typeof input.relativeStrengthVsSpy === 'number',
    hasSector: false,
    hasCatalyst: (input.catalystContribution ?? 0) > 0,
    hasFavorableRr: typeof input.riskReward === 'number' && input.riskReward >= deskIntelligence.minRiskRewardRatio,
    hasCleanInvalidation: (evaln?.invalidationConditions?.length ?? 0) > 0,
    oscillatorBuyCount: (evaln?.conditionsMet || []).filter((c) => /rsi|macd|stoch/i.test(c)).length,
  });

  const tradeQuality = evaln ? Math.round(evaln.setupScore) : null;
  const evidence = evaln ? Math.min(100, (evaln.conditionsMet?.length || 0) * 12) : null;
  const contradiction = Math.min(100, (input.contradictions?.length || evaln?.contradictions?.length || 0) * 20);
  const rrScore = typeof input.riskReward === 'number' ? Math.min(100, Math.round((input.riskReward / 3) * 100)) : null;
  const timing = regime ? Math.round(regime.confidence * 100) : null;
  const catalyst = typeof input.catalystContribution === 'number' ? Math.round(Math.min(100, input.catalystContribution * 100)) : null;
  const liquidity: number | null = null;
  const regimeAlign = evaln && regime ? Math.round((evaln.confidence || 0) * 100) : null;
  const invalidation = evaln?.invalidationConditions?.length ? Math.min(100, evaln.invalidationConditions.length * 25) : null;
  const sample = input.evSampleSize ?? 0;
  const evQuality = sample >= tradingSafety.minSampleSizeForTrust ? 'MEASURED' : (sample > 0 ? 'INSUFFICIENT_SAMPLE' : 'UNAVAILABLE');

  const scores: Record<string, SourcedScore> = {
    TradeOpportunityScore: score('TradeOpportunityScore', tradeQuality, 'StrategyEngine.setupScore', 'Setup score from the ranked strategy evaluation.'),
    TradeQualityScore: score('TradeQualityScore', confluence.score, 'ConfluenceEngine', confluence.note),
    EvidenceScore: score('EvidenceScore', evidence, 'StrategyEvaluation.conditionsMet', 'Count of named conditions met; not a probability.'),
    ContradictionScore: score('ContradictionScore', contradiction, 'StrategyEvaluation.contradictions', 'Higher means more named contradictions.'),
    ExecutionQualityScore: score('ExecutionQualityScore', null, 'none', 'DATA UNAVAILABLE: fill quality is not persisted as a pre-trade score.', 'UNAVAILABLE'),
    RiskQualityScore: score('RiskQualityScore', rrScore, 'ExpectedValue/riskRewardRatio', typeof input.riskReward === 'number' ? `R:R ${input.riskReward.toFixed(2)}` : 'R:R not computed.', sample >= 20 ? 'MEASURED' : 'INSUFFICIENT_SAMPLE'),
    TimingScore: score('TimingScore', timing, 'RegimeEngine.confidence', 'Agreement ratio across regime features — not a win probability.'),
    CatalystScore: score('CatalystScore', catalyst, 'NewsCatalystStore', input.newsEmitsTradeIdeas ? 'News is allowed to emit ideas (override).' : 'News is catalyst-only.'),
    LiquidityScore: score('LiquidityScore', liquidity, 'none', 'DATA UNAVAILABLE: no L2 or spread feed. WHY: Alpaca IEX is top-of-book. IMPACT: liquidity quality cannot be scored. HOW TO FIX: add a real L2/spread source.', 'UNAVAILABLE'),
    RegimeAlignmentScore: score('RegimeAlignmentScore', regimeAlign, 'StrategyEvaluation.confidence after regime ranking', regime ? `Regime ${regime.regime}` : 'No regime.'),
    InvalidationScore: score('InvalidationScore', invalidation, 'StrategyEvaluation.invalidationConditions', 'Presence of named invalidation — not a probability of being stopped.'),
    ProbabilityQuality: score('ProbabilityQuality', input.expectedValueR ?? null, 'ExpectedValue.ts', `Sample ${sample}. ${evQuality === 'MEASURED' ? deskIntelligence.probabilityQuality.empiricallyValidated : deskIntelligence.probabilityQuality.unavailable}`, evQuality),
  };

  let waitCode: string | null = 'WAIT';
  if (dq?.tradeBlocked) waitCode = 'STALE_DATA';
  else if (!evaln) waitCode = 'NO_CONFLUENCE';
  else if (typeof input.riskReward === 'number' && input.riskReward < deskIntelligence.minRiskRewardRatio) waitCode = 'BAD_RR';
  else if ((input.contradictions?.length || 0) >= 2) waitCode = 'CONTRADICTORY_SIGNALS';
  else if (evaln.strategy === 'SMC_LIQUIDITY_SWEEP') waitCode = 'UNVALIDATED_STRATEGY';
  else if (sample < 20) waitCode = 'INSUFFICIENT_SAMPLE';
  else waitCode = null;

  const wait = waitCode ? noTradeReasonByCode(waitCode) : null;
  const disposition: EliteTraderDecision['disposition'] = waitCode ? 'WAIT' : (evaln?.side === 'SELL' ? 'SELL' : 'WATCHLIST');

  return {
    schemaVersion: 1,
    disposition,
    waitReasonCode: wait?.code ?? waitCode,
    waitReasonLabel: wait?.label ?? waitCode,
    questions: {
      A_regime: regime ? `${regime.regime} (vol ${regime.volatility}, structure ${regime.marketStructure})` : 'DATA UNAVAILABLE',
      B_context: input.relativeStrengthVsSpy == null ? 'DATA UNAVAILABLE: relative strength vs SPY not computed' : `RS vs SPY ${input.relativeStrengthVsSpy}`,
      C_strongestSetup: setups.ranked[0]?.label ?? 'NONE',
      D_support: (evaln?.conditionsMet || []).join('; ') || 'NONE',
      E_contradict: (input.contradictions || evaln?.contradictions || []).join('; ') || 'NONE',
      F_invalidate: (evaln?.invalidationConditions || []).join('; ') || 'NONE',
      G_reward: evaln?.target?.price != null ? String(evaln.target.price) : 'DATA UNAVAILABLE',
      H_risk: evaln?.stop?.price != null ? String(evaln.stop.price) : 'DATA UNAVAILABLE',
      I_asymmetric: typeof input.riskReward === 'number' ? String(input.riskReward >= deskIntelligence.minRiskRewardRatio) : 'DATA UNAVAILABLE',
      J_confidence: evaln ? String(evaln.confidence) : 'DATA UNAVAILABLE',
      K_probabilityQuality: scores.ProbabilityQuality.evidenceQuality,
      L_liquidity: 'DATA UNAVAILABLE',
      M_catalyst: scores.CatalystScore.note,
      N_timing: scores.TimingScore.note,
      O_wait: wait?.label ?? 'No WAIT code — still not an order.',
      P_exit: (evaln?.invalidationConditions || []).join('; ') || 'PortfolioMonitor trailing/stop/target via RiskEngine',
      Q_reverse: 'Named contradictions or thesis invalidation — never an AI-placed reverse order.',
    },
    scores,
    setups,
    confluence,
  };
}
