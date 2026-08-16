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

export interface DeskIntelligenceConfig {
  minRiskRewardRatio: number;
  highVolatilityConfidenceMultiplier: number;
  newsEmitsTradeIdeas: boolean;
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
  if (typeof raw.newsEmitsTradeIdeas !== 'boolean') {
    throw new Error('config/deskIntelligence.json missing boolean newsEmitsTradeIdeas');
  }
  if (!raw.strategyFamilies || !raw.regimeFamilyRelevance) {
    throw new Error('config/deskIntelligence.json missing strategyFamilies or regimeFamilyRelevance');
  }
  return raw;
}

export const deskIntelligence: DeskIntelligenceConfig = loadDeskIntelligence();

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
