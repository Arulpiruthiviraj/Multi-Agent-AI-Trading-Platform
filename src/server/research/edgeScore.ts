/**
 * Evidence-based trading-edge score. Adding files/tests does not raise the score.
 * 0–20 remains the band until REAL_MARKET_DATA NEXT_BAR OOS/WFO/robustness/paper exist.
 */
import type { StrategyEvidence } from './promotionEngine';
import { deriveLifecycleStatus } from './promotionEngine';

export function tradingEdgeScore(e: StrategyEvidence): { score: number; band: string; reason: string } {
  const status = deriveLifecycleStatus(e);
  if (e.dataProvenance !== 'REAL_MARKET_DATA' || status === 'UNTESTED') {
    return { score: 8, band: '0-20', reason: 'No demonstrated repeatable edge. CORE UNTESTED on REAL_MARKET_DATA NEXT_BAR_OPEN.' };
  }
  if (status === 'DEGRADED' || status === 'RETIRED') {
    return { score: 6, band: '0-20', reason: `Status ${status}. Score does not increase.` };
  }
  if (status === 'OOS_TESTING' || status === 'BACKTEST_ONLY') {
    return { score: 8, band: '0-20', reason: 'In-sample or incomplete OOS is not an edge.' };
  }
  if (status === 'WALK_FORWARD_TESTING' || status === 'ROBUSTNESS_TESTING') {
    return { score: 25, band: '21-40', reason: 'Research evidence emerging only if OOS/WFO booleans are from artifacts.' };
  }
  if (status === 'PAPER_TESTING') {
    return { score: 45, band: '41-60', reason: 'WFO/robustness flags set; paper not complete.' };
  }
  if (status === 'VALIDATED') {
    return { score: 70, band: '61-75', reason: 'Research+paper flags set. Still not LIVE.' };
  }
  if (status === 'LIVE_CANDIDATE' || status === 'LIVE_APPROVED') {
    return { score: 80, band: '76-85', reason: 'Candidate flags only. LIVE remains operator-gated.' };
  }
  return { score: 8, band: '0-20', reason: 'Default: no demonstrated edge.' };
}
