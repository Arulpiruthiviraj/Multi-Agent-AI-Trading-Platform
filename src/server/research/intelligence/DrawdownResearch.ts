/**
 * Drawdown Analysis (Phase 13). Forensic audit (2026-08-25) confirmed no reusable max-drawdown/
 * duration/underwater-curve function existed anywhere in the codebase — only an inline peak/dd
 * loop inside BacktestEngine.ts producing maxDrawdownPct alone, and the live gate-10 boolean check
 * (BacktestRiskParity.ts's drawdownBlocksNewBuys). This is genuinely new, not a duplicate: it
 * reuses neither of those internally (both stay the live/backtest authorities for their own
 * purposes) and does not modify either. Research/analytics only — never writes to portfolio state
 * or reads maxPortfolioDrawdownPct to change it.
 */
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export interface DrawdownPoint {
  index: number;
  timestamp: number;
  equity: number;
  peakEquity: number;
  drawdownPct: number;
}

export interface DrawdownPeriod {
  startIndex: number;
  troughIndex: number;
  endIndex: number | null;
  peakEquity: number;
  troughEquity: number;
  drawdownPct: number;
  durationBars: number;
  recoveryBars: number | null;
}

export interface DrawdownAnalysis {
  maxDrawdownPct: number;
  averageDrawdownPct: number;
  longestDrawdownDurationBars: number;
  longestRecoveryDurationBars: number | null;
  currentlyUnderwater: boolean;
  currentDrawdownPct: number;
  underwaterCurve: DrawdownPoint[];
  periods: DrawdownPeriod[];
}

/**
 * Real max-DD/duration/underwater-curve computation from an equity series (portfolio value or
 * cumulative strategy P&L over time — caller's choice, honestly labeled by them, not us).
 */
export function analyzeDrawdown(
  equitySeries: Array<{ timestamp: number; equity: number }>,
): DrawdownAnalysis {
  const points: DrawdownPoint[] = [];
  const periods: DrawdownPeriod[] = [];
  let peak = equitySeries.length ? equitySeries[0].equity : 0;
  let peakIndex = 0;
  let inDrawdown = false;
  let periodStart = 0;
  let troughIndex = 0;
  let troughEquity = peak;

  equitySeries.forEach((pt, i) => {
    if (pt.equity >= peak) {
      if (inDrawdown) {
        periods.push({
          startIndex: periodStart,
          troughIndex,
          endIndex: i,
          peakEquity: peak,
          troughEquity,
          drawdownPct: peak > 0 ? (peak - troughEquity) / peak : 0,
          durationBars: troughIndex - periodStart,
          recoveryBars: i - troughIndex,
        });
        inDrawdown = false;
      }
      peak = pt.equity;
      peakIndex = i;
    } else {
      if (!inDrawdown) {
        inDrawdown = true;
        periodStart = peakIndex;
        troughIndex = i;
        troughEquity = pt.equity;
      } else if (pt.equity < troughEquity) {
        troughIndex = i;
        troughEquity = pt.equity;
      }
    }
    points.push({
      index: i,
      timestamp: pt.timestamp,
      equity: pt.equity,
      peakEquity: peak,
      drawdownPct: peak > 0 ? (peak - pt.equity) / peak : 0,
    });
  });

  if (inDrawdown) {
    periods.push({
      startIndex: periodStart,
      troughIndex,
      endIndex: null,
      peakEquity: peak,
      troughEquity,
      drawdownPct: peak > 0 ? (peak - troughEquity) / peak : 0,
      durationBars: troughIndex - periodStart,
      recoveryBars: null,
    });
  }

  const maxDrawdownPct = periods.length ? Math.max(...periods.map((p) => p.drawdownPct)) : 0;
  const averageDrawdownPct = periods.length
    ? periods.reduce((s, p) => s + p.drawdownPct, 0) / periods.length
    : 0;
  const closed = periods.filter((p) => p.recoveryBars !== null);
  const longestDrawdownDurationBars = periods.length ? Math.max(...periods.map((p) => p.durationBars)) : 0;
  const longestRecoveryDurationBars = closed.length
    ? Math.max(...closed.map((p) => p.recoveryBars as number))
    : null;
  const last = points[points.length - 1];

  return {
    maxDrawdownPct,
    averageDrawdownPct,
    longestDrawdownDurationBars,
    longestRecoveryDurationBars,
    currentlyUnderwater: !!last && last.equity < last.peakEquity,
    currentDrawdownPct: last?.drawdownPct ?? 0,
    underwaterCurve: points,
    periods,
  };
}

export function runDrawdownResearch(opts: {
  symbol: string;
  source: string;
  equitySeries: Array<{ timestamp: number; equity: number }>;
  traceId?: string;
}): ResearchResult<DrawdownAnalysis> {
  const dataQuality: DataQualityMeta = {
    source: opts.source,
    symbol: opts.symbol,
    timestamp: new Date().toISOString(),
    sampleSize: opts.equitySeries.length,
    missingFields: opts.equitySeries.length === 0 ? ['equitySeries'] : [],
    staleness: opts.equitySeries.length > 0 ? 'FRESH' : 'UNKNOWN',
    assumptions: ['Drawdown percentages are relative to the running peak of the supplied series, not broker equity directly.'],
    quality: opts.equitySeries.length >= 20 ? 'GREEN' : opts.equitySeries.length > 0 ? 'YELLOW' : 'UNAVAILABLE',
  };
  const analysis = analyzeDrawdown(opts.equitySeries);
  const result = wrapResearchResult({ capability: 'DRAWDOWN_ANALYSIS', label: 'RESEARCH', dataQuality, data: analysis });
  emitResearchEvent('DRAWDOWN_ANALYSIS_COMPLETED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.symbol,
    maxDrawdownPct: analysis.maxDrawdownPct,
    periods: analysis.periods.length,
  });
  return result;
}
