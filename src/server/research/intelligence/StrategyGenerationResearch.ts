/**
 * Strategy Generation (Phase 3). Composes a structured StrategyDefinition RESEARCH artifact from
 * the real, already-implemented CORE/EXPERIMENTAL strategy catalog (quant/strategies/StrategyEngine.ts)
 * ranked against the caller's inputs — it does not synthesize a brand-new, never-implemented
 * strategy from nothing (that would mean fabricating entry/exit rules with no real evaluate()
 * function behind them, which this module explicitly refuses to do). Every generated artifact
 * traces back to a real strategy id whose entry/exit/invalidation logic already exists and is
 * already unit-tested. Never auto-activated: generating this artifact does not add the strategy to
 * QuantSignalAgent's live evaluation set or change any config flag.
 */
import { ALL_STRATEGIES, EXPERIMENTAL_STRATEGIES } from '../../quant/strategies/StrategyEngine';
import { STRATEGY_TYPICAL_HOLDING_PERIOD } from '../../quant/strategies/types';
import type { RegimeLabel } from '../../quant/RegimeEngine';
import { researchSafety } from '../../config/researchSafety';
import { tradingSafety } from '../../config/tradingSafety';
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export interface GeneratedStrategyDefinition {
  strategyId: string;
  displayName: string;
  hypothesis: string;
  entryRules: string;
  exitRules: string;
  stopConditions: string;
  positionSizingAssumptions: string;
  expectedHoldingPeriod: string;
  requiredData: string[];
  riskCharacteristics: string;
  regimeSuitability: RegimeLabel[];
  backtestRequirements: string;
  experimental: boolean;
}

export function runStrategyGenerationResearch(opts: {
  targetRegime?: RegimeLabel;
  riskProfile?: 'conservative' | 'moderate' | 'aggressive';
  universe: string[];
  timeframe: string;
  traceId?: string;
}): ResearchResult<GeneratedStrategyDefinition[]> {
  const catalog = [
    ...ALL_STRATEGIES.map((s) => ({ ...s, experimental: false })),
    ...EXPERIMENTAL_STRATEGIES.map((s) => ({ ...s, experimental: true })),
  ];
  const ranked = opts.targetRegime
    ? catalog.filter((s) => s.applicableRegimes.includes(opts.targetRegime as RegimeLabel))
    : catalog;

  const sizingByRisk = {
    conservative: `PERCENT_OF_EQUITY (small), stop-per-share from tradingSafety.stopLossAssumptionPct (${tradingSafety.stopLossAssumptionPct}) — reused, not redefined here.`,
    moderate: `FIXED_DOLLAR (default $${tradingSafety.maxDailyBuyNotionalDollars ? 'per tradingSafety.json' : '3000'}) — the live PositionSizing.ts default.`,
    aggressive: 'PERCENT_OF_EQUITY (larger), still hard-capped by RiskEngine gate #16/#23 regardless of this suggestion.',
  } as const;

  const definitions: GeneratedStrategyDefinition[] = ranked.map((s) => ({
    strategyId: s.id,
    displayName: s.displayName,
    hypothesis: `${s.displayName} is applicable in ${s.applicableRegimes.join('/')} regimes; real entry/confirmation/invalidation logic already lives in quant/strategies/ and is unit-tested — this artifact does not restate it as free text to avoid drift from the real implementation.`,
    entryRules: `See quant/strategies (${s.id}).evaluate() — real, existing conditionsMet/conditionsFailed logic, not restated here to avoid a second, driftable copy.`,
    exitRules: STRATEGY_TYPICAL_HOLDING_PERIOD[s.id] ?? 'Not documented in STRATEGY_TYPICAL_HOLDING_PERIOD yet.',
    stopConditions: 'LevelSuggestion from evaluate().stop (real, price + basis) — never a bare number with no stated reason.',
    positionSizingAssumptions: sizingByRisk[opts.riskProfile ?? 'moderate'],
    expectedHoldingPeriod: STRATEGY_TYPICAL_HOLDING_PERIOD[s.id] ?? 'undocumented',
    requiredData: ['trend', 'momentum', 'volatility', 'volume', 'priceAction', 'supportResistance', 'regime', 'marketContext'],
    riskCharacteristics: s.experimental
      ? 'EXPERIMENTAL — UNVALIDATED per quantExperimentalStrategies.json; off-regime confidence is discounted, never zeroed (regimeMismatchConfidenceMultiplier).'
      : 'CORE — evaluated in the live evaluateAll() cycle when QUANT_ENGINE_ENABLED=true; still gated by ChiefTrader consensus and RiskEngine like every other idea.',
    regimeSuitability: s.applicableRegimes,
    backtestRequirements: `Requires >= ${researchSafety.minOosTrades} closed trades (researchSafety.minOosTrades) before any win-rate/EV claim is trusted (see RiskRewardResearch.ts, AlphaEdgeResearch.ts).`,
    experimental: s.experimental,
  }));

  const dataQuality: DataQualityMeta = {
    source: 'quant/strategies/StrategyEngine.ts catalog (reused, unmodified) — composed, not fabricated',
    timestamp: new Date().toISOString(),
    sampleSize: definitions.length,
    missingFields: definitions.length === 0 ? [`no CORE/EXPERIMENTAL strategy applies to regime ${opts.targetRegime}`] : [],
    staleness: 'FRESH',
    assumptions: [`universe=${opts.universe.join(',')}`, `timeframe=${opts.timeframe}`, 'Every generated definition traces to a real, already-implemented strategy id — this module does not invent new entry/exit logic.'],
    quality: definitions.length > 0 ? 'GREEN' : 'YELLOW',
  };

  const result = wrapResearchResult({ capability: 'STRATEGY_GENERATION', label: 'RESEARCH', dataQuality, data: definitions });
  emitResearchEvent('RESEARCH_STRATEGY_GENERATED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    targetRegime: opts.targetRegime,
    generatedCount: definitions.length,
  });
  return result;
}
