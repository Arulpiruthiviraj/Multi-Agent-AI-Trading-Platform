/**
 * Compare organic paper summary to a canonical research run. Never invent either side.
 */
import type { CanonicalBacktestResult } from './canonicalNextBarEngine';
import { summarizeOrganicPaper } from './organicPaper';
import { researchSafety } from '../config/researchSafety';

export function reconcilePaperVsResearch(
  research: CanonicalBacktestResult | null,
  paperRows: Array<{
    status: string;
    side: string;
    profitLoss?: number | null;
    traceId?: string | null;
    reasoning?: string | null;
    executionEnvironment?: string | null;
  }>,
): {
  status: 'UNAVAILABLE' | 'INSUFFICIENT_SAMPLE' | 'RESEARCH_PAPER_DIVERGENCE' | 'COMPARED';
  researchExpectancy: number | null;
  paperExpectancy: number | null;
  expectancyDriftPct: number | null;
  invented: false;
  note: string;
} {
  const paper = summarizeOrganicPaper(paperRows, researchSafety.minPaperTrades);
  if (!research) {
    return {
      status: 'UNAVAILABLE',
      researchExpectancy: null,
      paperExpectancy: paper.expectancy,
      expectancyDriftPct: null,
      invented: false,
      note: 'No canonical NEXT_BAR research run. Not divergence theater.',
    };
  }
  if (paper.closedTradeCount < researchSafety.minPaperTrades || research.metrics.tradeCount < researchSafety.minOosTrades) {
    return {
      status: 'INSUFFICIENT_SAMPLE',
      researchExpectancy: research.metrics.expectancy,
      paperExpectancy: paper.expectancy,
      expectancyDriftPct: null,
      invented: false,
      note: 'Need minPaperTrades organic SELL fills and minOosTrades research trades.',
    };
  }
  const re = research.metrics.expectancy ?? 0;
  const pe = paper.expectancy ?? 0;
  const drift = re === 0 ? null : ((pe - re) / Math.abs(re)) * 100;
  const diverged = drift != null && Math.abs(drift) > 50;
  return {
    status: diverged ? 'RESEARCH_PAPER_DIVERGENCE' : 'COMPARED',
    researchExpectancy: re,
    paperExpectancy: pe,
    expectancyDriftPct: drift,
    invented: false,
    note: diverged
      ? 'Paper expectancy differs >50% from research. MODEL_EXECUTION_DRIFT. Not success.'
      : 'Compared only. Not LIVE_CANDIDATE.',
  };
}
