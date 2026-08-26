/**
 * Alpha / Edge Detection (Phase 15). Does not invent a new statistics engine — reuses
 * wilsonInterval() (effectiveSampleSize.ts, already the codebase's real confidence-interval math)
 * to judge whether a win rate is statistically distinguishable from a coin flip, and takes a
 * walk-forward result (WalkForwardResearch.ts) plus an optional cost-stressed re-run as its real
 * out-of-sample/cost-sensitivity evidence. A positive historical return alone is never enough to
 * call something "alpha" — see the classification ladder below.
 */
import { wilsonInterval } from '../effectiveSampleSize';
import { researchSafety } from '../../config/researchSafety';
import type { WalkForwardClassification } from './WalkForwardResearch';
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export type EdgeClassification = 'RESEARCH_CANDIDATE' | 'POSSIBLE_EDGE' | 'UNVALIDATED_EDGE' | 'VALIDATED_EDGE';

export interface AlphaEdgeAnalysis {
  classification: EdgeClassification;
  hypothesis: string;
  sampleSize: number;
  winRateInterval: ReturnType<typeof wilsonInterval>;
  outOfSampleEvidence: 'NONE' | 'FRAGILE' | 'POSITIVE';
  costSensitivityChecked: boolean;
  costSensitivityPositive: boolean | null;
  reasoning: string;
}

export function classifyEdge(opts: {
  wins: number;
  totalTrades: number;
  walkForward?: WalkForwardClassification;
  costStressedExpectancyPositive?: boolean | null;
}): { classification: EdgeClassification; reasoning: string; oos: AlphaEdgeAnalysis['outOfSampleEvidence'] } {
  const interval = wilsonInterval(opts.wins, opts.totalTrades);
  const oos: AlphaEdgeAnalysis['outOfSampleEvidence'] =
    !opts.walkForward ? 'NONE'
    : opts.walkForward.report.status === 'COMPLETED' && (opts.walkForward.report.medianTestExpectancy ?? 0) > 0 ? 'POSITIVE'
    : opts.walkForward.report.status === 'FRAGILE' ? 'FRAGILE'
    : 'NONE';

  if (opts.totalTrades < researchSafety.minOosTrades) {
    return { classification: 'RESEARCH_CANDIDATE', reasoning: `Only ${opts.totalTrades} trades — below the ${researchSafety.minOosTrades}-trade floor for any statistical claim.`, oos };
  }
  if (interval.lower === null || interval.lower <= 0.5) {
    return { classification: 'RESEARCH_CANDIDATE', reasoning: `95% win-rate confidence interval [${interval.lower?.toFixed(3)}, ${interval.upper?.toFixed(3)}] includes 50% — not statistically distinguishable from chance.`, oos };
  }
  if (oos === 'NONE' || oos === 'FRAGILE') {
    return { classification: 'POSSIBLE_EDGE', reasoning: `Win rate is statistically above chance (interval lower bound ${interval.lower?.toFixed(3)}), but out-of-sample walk-forward evidence is ${oos === 'NONE' ? 'absent' : 'fragile'} — not yet validated.`, oos };
  }
  if (opts.costStressedExpectancyPositive === false) {
    return { classification: 'UNVALIDATED_EDGE', reasoning: 'Out-of-sample evidence is positive, but the edge does not survive a cost-stressed re-run — real transaction costs likely erase it.', oos };
  }
  if (opts.costStressedExpectancyPositive !== true) {
    return { classification: 'UNVALIDATED_EDGE', reasoning: 'Out-of-sample evidence is positive, but transaction-cost sensitivity has not been checked yet.', oos };
  }
  return { classification: 'VALIDATED_EDGE', reasoning: `Win rate above chance (lower bound ${interval.lower?.toFixed(3)}), positive out-of-sample walk-forward result, and survives cost stress. Still RESEARCH-only — only the graduation ladder (promotionEngine.ts), not this module, can advance a real strategy toward LIVE.`, oos };
}

export function runAlphaEdgeResearch(opts: {
  symbol: string;
  strategyId: string;
  hypothesis: string;
  wins: number;
  totalTrades: number;
  walkForward?: WalkForwardClassification;
  costStressedExpectancyPositive?: boolean | null;
  traceId?: string;
}): ResearchResult<AlphaEdgeAnalysis> {
  const interval = wilsonInterval(opts.wins, opts.totalTrades);
  const { classification, reasoning, oos } = classifyEdge(opts);

  const dataQuality: DataQualityMeta = {
    source: 'effectiveSampleSize.wilsonInterval (reused) + WalkForwardResearch.ts',
    symbol: opts.symbol,
    timestamp: new Date().toISOString(),
    sampleSize: opts.totalTrades,
    missingFields: [
      ...(opts.walkForward ? [] : ['walkForward result not supplied']),
      ...(opts.costStressedExpectancyPositive == null ? ['cost-sensitivity check not supplied'] : []),
    ],
    staleness: 'FRESH',
    assumptions: [`Requires >= ${researchSafety.minOosTrades} trades and a 95% Wilson interval lower bound > 0.5 before any classification above RESEARCH_CANDIDATE.`],
    quality: opts.totalTrades >= researchSafety.minOosTrades ? 'GREEN' : opts.totalTrades > 0 ? 'YELLOW' : 'UNAVAILABLE',
  };

  const data: AlphaEdgeAnalysis = {
    classification,
    hypothesis: opts.hypothesis,
    sampleSize: opts.totalTrades,
    winRateInterval: interval,
    outOfSampleEvidence: oos,
    costSensitivityChecked: opts.costStressedExpectancyPositive != null,
    costSensitivityPositive: opts.costStressedExpectancyPositive ?? null,
    reasoning,
  };

  const result = wrapResearchResult({ capability: 'ALPHA_EDGE_DETECTION', label: 'RESEARCH', dataQuality, data });
  emitResearchEvent('ALPHA_RESEARCH_COMPLETED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.symbol,
    strategyId: opts.strategyId,
    classification,
  });
  return result;
}
