/**
 * Macro-Based Strategy (Phase 14). Deliberately read-only against ExternalDataCache — reuses
 * whatever MacroAgent has already fetched (same alphavantage:macro:GLOBAL cache row) rather than
 * making its own AlphaVantage calls. This is a safety-motivated choice, not just a reuse one: the
 * AlphaVantage daily budget was found this session to already be under real pressure (a dedicated
 * reservation was added so MacroAgent isn't starved by FundamentalAgent) — a second consumer
 * spending its own requests here would reopen that exact problem. If the cache is empty or stale,
 * this honestly reports DATA_UNAVAILABLE; it never fabricates a macro value.
 */
import { runtimeIntervals } from '../../config/runtimeIntervals';
import { ExternalDataCache } from '../../services/ExternalDataCache';
import { wrapResearchResult, ResearchResult, DataQualityMeta, unavailableDataQuality } from './types';
import { emitResearchEvent } from './researchEventLog';

interface CachedMacro {
  inflation: string;
  fedFundsRate: string;
  unemployment: string;
}

export interface MacroStrategyAnalysis {
  inflation: string | 'DATA_UNAVAILABLE';
  fedFundsRate: string | 'DATA_UNAVAILABLE';
  unemployment: string | 'DATA_UNAVAILABLE';
  /** Simple, transparent rule-based read — not an AI-invented narrative, not a fabricated score. */
  macroBias: 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL' | 'DATA_UNAVAILABLE';
  reasoning: string;
}

function deriveBias(macro: CachedMacro | null): { bias: MacroStrategyAnalysis['macroBias']; reasoning: string } {
  if (!macro || macro.inflation === 'UNKNOWN') {
    return { bias: 'DATA_UNAVAILABLE', reasoning: 'No cached macro data available from MacroAgent — this module never fetches its own to avoid competing for the shared AlphaVantage budget.' };
  }
  const fed = parseFloat(macro.fedFundsRate);
  const infl = parseFloat(macro.inflation);
  if (!Number.isFinite(fed) || !Number.isFinite(infl)) {
    return { bias: 'DATA_UNAVAILABLE', reasoning: 'Cached macro values are present but not numeric — cannot derive a bias without fabricating one.' };
  }
  if (infl > 4 && fed > 4) return { bias: 'RISK_OFF', reasoning: `Elevated inflation (${infl}%) with a high fed funds rate (${fed}%) — restrictive-policy backdrop.` };
  if (infl < 2.5 && fed < 3) return { bias: 'RISK_ON', reasoning: `Low inflation (${infl}%) with an accommodative fed funds rate (${fed}%).` };
  return { bias: 'NEUTRAL', reasoning: `Inflation ${infl}% / fed funds ${fed}% do not clear either bias threshold.` };
}

export async function runMacroStrategyResearch(opts: { symbol?: string; traceId?: string }): Promise<ResearchResult<MacroStrategyAnalysis>> {
  const cached = await ExternalDataCache.getFresh<CachedMacro>('alphavantage', 'macro', null, runtimeIntervals.macroCacheMaxAgeMs);
  const { bias, reasoning } = deriveBias(cached);

  const data: MacroStrategyAnalysis = {
    inflation: cached?.inflation ?? 'DATA_UNAVAILABLE',
    fedFundsRate: cached?.fedFundsRate ?? 'DATA_UNAVAILABLE',
    unemployment: cached?.unemployment ?? 'DATA_UNAVAILABLE',
    macroBias: bias,
    reasoning,
  };

  const dataQuality: DataQualityMeta = cached
    ? {
        source: 'ExternalDataCache (alphavantage:macro:GLOBAL) — read-only reuse of MacroAgent\'s own cached fetch',
        symbol: opts.symbol,
        timestamp: new Date().toISOString(),
        sampleSize: 1,
        missingFields: [],
        staleness: 'FRESH',
        assumptions: ['macroBias is a simple threshold rule (Phase 14 explicitly forbids fabricated macro narratives), not a model'],
        quality: 'GREEN',
      }
    : unavailableDataQuality('ExternalDataCache (alphavantage:macro:GLOBAL)', 'No fresh cached macro data from MacroAgent', opts.symbol);

  const result = wrapResearchResult({ capability: 'MACRO_BASED_STRATEGY', label: 'ADVISORY', dataQuality, data });
  emitResearchEvent('MACRO_ANALYSIS_COMPLETED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.symbol,
    macroBias: bias,
  });
  return result;
}
