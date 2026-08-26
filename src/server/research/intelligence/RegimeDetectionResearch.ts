/**
 * Market Regime Detection (Phase 7). Thin wrapper — reuses the exact same classifyRegime() the
 * live QuantSignalAgent already calls (quant/RegimeEngine.ts). Does not reimplement regime
 * classification, and does not feed back into QuantSignalAgent/ChiefTrader; this is a standalone,
 * on-demand research call for a caller-supplied bar series.
 */
import { classifyRegime } from '../../quant/RegimeEngine';
import type { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export function runRegimeDetectionResearch(opts: {
  symbol: string;
  bars: Bar[];
  traceId?: string;
}) {
  const regime = classifyRegime(opts.bars);
  const dataQuality: DataQualityMeta = {
    source: 'RegimeEngine.classifyRegime (reused, same function the live QuantEngine calls)',
    symbol: opts.symbol,
    timestamp: new Date().toISOString(),
    sampleSize: opts.bars.length,
    missingFields: regime.insufficientData ? ['insufficient bar history for a trustworthy classification'] : [],
    staleness: opts.bars.length > 0 ? 'FRESH' : 'UNKNOWN',
    assumptions: [],
    quality: opts.bars.length === 0 ? 'UNAVAILABLE' : regime.insufficientData ? 'YELLOW' : 'GREEN',
  };
  const result: ResearchResult<typeof regime> = wrapResearchResult({
    capability: 'MARKET_REGIME_DETECTION',
    label: 'ADVISORY',
    dataQuality,
    data: regime,
  });
  emitResearchEvent('REGIME_DETECTED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.symbol,
    regime: regime.regime,
    confidence: regime.confidence,
  });
  return result;
}
