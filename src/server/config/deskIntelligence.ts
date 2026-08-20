/**
 * Module: config/deskIntelligence
 *
 * Reviewed JSON overlay for elite-desk ranking, news-as-catalyst policy, and EV labeling.
 * Does not submit orders. Missing keys fail boot.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import type { RegimeLabel } from '../quant/RegimeEngine';

export type DeskFamily =
  | 'momentum'
  | 'trend'
  | 'mean_reversion'
  | 'market_structure'
  | 'volatility'
  | 'volume'
  | 'intraday';

// Phase F Step 2 — replaces the old plain `newsEmitsTradeIdeas: boolean` with an explicit mode.
// DISABLED: NewsEngine's pipeline does not run at all (no ingestion, no clustering, no news_veto
//   feed - a strict superset of "off", not equivalent to today's old `false`).
// CATALYST_ONLY: today's actual default behavior - ingests, clusters, analyzes, emits
//   NEWS_CATALYST, feeds RiskEngine's news_veto gate, but never emits a TRADE_IDEA_GENERATED.
//   Exactly what `newsEmitsTradeIdeas: false` already did.
// ACTIVE_OBSERVE: reserved for a future Phase F increment (structured multi-dimensional
//   assessment + prediction ledger) - not yet distinguishable from CATALYST_ONLY in this codebase
//   and not wired to anything additional yet.
// ACTIVE_VOTE / ACTIVE_VOTE_AND_VETO: NewsEngine emits TRADE_IDEA_GENERATED - exactly what
//   `newsEmitsTradeIdeas: true` already did. The two are not yet distinguished from each other
//   (RiskEngine's news_veto gate already runs unconditionally regardless of mode today).
export type NewsAgentMode = 'DISABLED' | 'CATALYST_ONLY' | 'ACTIVE_OBSERVE' | 'ACTIVE_VOTE' | 'ACTIVE_VOTE_AND_VETO';

const NEWS_AGENT_MODES: readonly NewsAgentMode[] = [
  'DISABLED', 'CATALYST_ONLY', 'ACTIVE_OBSERVE', 'ACTIVE_VOTE', 'ACTIVE_VOTE_AND_VETO',
];

export interface DeskIntelligenceConfig {
  minRiskRewardRatio: number;
  highVolatilityConfidenceMultiplier: number;
  newsAgentMode: NewsAgentMode;
  probabilityQuality: {
    empiricallyValidated: string;
    modelEstimate: string;
    unavailable: string;
  };
  dataQuality: {
    greenMaxStaleMs: number;
    yellowMaxStaleMs: number;
  };
  strategyFamilies: Record<string, DeskFamily>;
  regimeFamilyRelevance: Record<string, Record<DeskFamily, number>>;
}

function loadDeskIntelligence(): DeskIntelligenceConfig {
  const raw = loadRepoConfigJson<DeskIntelligenceConfig>('deskIntelligence.json');
  if (typeof raw.minRiskRewardRatio !== 'number' || raw.minRiskRewardRatio <= 0) {
    throw new Error('config/deskIntelligence.json missing positive minRiskRewardRatio');
  }
  if (typeof raw.highVolatilityConfidenceMultiplier !== 'number' || raw.highVolatilityConfidenceMultiplier <= 0) {
    throw new Error('config/deskIntelligence.json missing positive highVolatilityConfidenceMultiplier');
  }
  if (typeof raw.newsAgentMode !== 'string' || !NEWS_AGENT_MODES.includes(raw.newsAgentMode as NewsAgentMode)) {
    throw new Error(
      `config/deskIntelligence.json missing/invalid newsAgentMode (must be one of ${NEWS_AGENT_MODES.join(', ')})`,
    );
  }
  if (!raw.strategyFamilies || !raw.regimeFamilyRelevance) {
    throw new Error('config/deskIntelligence.json missing strategyFamilies or regimeFamilyRelevance');
  }
  return raw;
}

export const deskIntelligence: DeskIntelligenceConfig = loadDeskIntelligence();

/** True only in ACTIVE_VOTE / ACTIVE_VOTE_AND_VETO - the same gate `newsEmitsTradeIdeas: true` was. */
export function newsAgentEmitsTradeIdeas(): boolean {
  return deskIntelligence.newsAgentMode === 'ACTIVE_VOTE' || deskIntelligence.newsAgentMode === 'ACTIVE_VOTE_AND_VETO';
}

/** True unless the mode is DISABLED - gates whether NewsEngine's pipeline runs at all. */
export function newsAgentPipelineEnabled(): boolean {
  return deskIntelligence.newsAgentMode !== 'DISABLED';
}

/**
 * True in ACTIVE_OBSERVE and above - gates the Phase F5 prediction ledger. Persisting predictions
 * is itself a no-trading-impact, additive capability, but the Phase F spec deliberately ties it to
 * ACTIVE_OBSERVE so the default (CATALYST_ONLY) leaves it dormant rather than silently writing
 * rows nobody asked for.
 */
export function newsAgentObservesPredictions(): boolean {
  return deskIntelligence.newsAgentMode === 'ACTIVE_OBSERVE'
    || deskIntelligence.newsAgentMode === 'ACTIVE_VOTE'
    || deskIntelligence.newsAgentMode === 'ACTIVE_VOTE_AND_VETO';
}

export function familyForStrategy(strategyId: string): DeskFamily | null {
  return deskIntelligence.strategyFamilies[strategyId] ?? null;
}

export function regimeRelevanceForStrategy(strategyId: string, regime: RegimeLabel): number {
  const family = familyForStrategy(strategyId);
  if (!family) return 1;
  const table = deskIntelligence.regimeFamilyRelevance[regime];
  const value = table?.[family];
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

export function rankEvaluationsForRegime<T extends { strategy: string; setupScore: number; confidence: number }>(
  evaluations: T[],
  regime: RegimeLabel,
): Array<T & { regimeRelevance: number; ensembleScore: number }> {
  return evaluations
    .map((e) => {
      const regimeRelevance = regimeRelevanceForStrategy(e.strategy, regime);
      const ensembleScore = e.setupScore * regimeRelevance * e.confidence;
      return { ...e, regimeRelevance, ensembleScore };
    })
    .sort((a, b) => b.ensembleScore - a.ensembleScore);
}
