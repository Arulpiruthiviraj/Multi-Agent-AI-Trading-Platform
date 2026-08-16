/**
 * Ranks named setups from config/setupCatalog.json against already-computed features.
 * Does not emit orders. Detectors marked UNAVAILABLE stay unavailable.
 */
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import type { RegimeResult } from '../quant/RegimeEngine';
import type { StrategyEvaluation } from '../quant/strategies/types';

export interface SetupCatalogRow {
  id: string;
  label: string;
  detector: string;
  validationStatus: string;
}

interface SetupCatalogFile {
  setups: SetupCatalogRow[];
}

const catalog = loadRepoConfigJson<SetupCatalogFile>('setupCatalog.json');

export interface RankedSetup {
  id: string;
  label: string;
  detector: string;
  validationStatus: string;
  available: boolean;
  rankHint: number | null;
  why: string;
  impact: string;
  howToFix: string;
}

export function rankSetups(input: {
  evaluation?: StrategyEvaluation | null;
  regime?: RegimeResult | null;
  catalystContribution?: number | null;
  relativeStrengthVsSpy?: number | null;
  vwapDistancePct?: number | null;
}): { ranked: RankedSetup[]; unavailableCount: number } {
  const evaln = input.evaluation ?? null;
  const ranked: RankedSetup[] = catalog.setups.map((row) => {
    if (row.detector === 'UNAVAILABLE') {
      return {
        ...row,
        available: false,
        rankHint: null,
        why: 'No detector is wired to this named pattern.',
        impact: 'This setup cannot contribute to a trade idea.',
        howToFix: 'Implement a deterministic detector on real bars, keep it UNVALIDATED until OOS evidence exists.',
      };
    }
    if (row.detector === evaln?.strategy) {
      return {
        ...row,
        available: true,
        rankHint: evaln.setupScore,
        why: `Matched StrategyEngine id ${evaln.strategy}.`,
        impact: row.validationStatus === 'UNVALIDATED'
          ? 'Experimental/SMC remains UNVALIDATED and must not be treated as a live edge.'
          : 'Ranking hint only — ChiefTrader + RiskEngine still authorize.',
        howToFix: 'None for detection; validation requires paper sample + walk-forward.',
      };
    }
    if (row.detector === 'feature_vwap_above' && typeof input.vwapDistancePct === 'number') {
      return { ...row, available: true, rankHint: input.vwapDistancePct >= 0 ? 60 : 20, why: `VWAP distance ${input.vwapDistancePct.toFixed(3)}%`, impact: 'Feature only.', howToFix: 'None.' };
    }
    if (row.detector === 'feature_vwap_below' && typeof input.vwapDistancePct === 'number') {
      return { ...row, available: true, rankHint: input.vwapDistancePct < 0 ? 60 : 20, why: `VWAP distance ${input.vwapDistancePct.toFixed(3)}%`, impact: 'Feature only.', howToFix: 'None.' };
    }
    if (row.detector === 'news_catalyst') {
      const c = input.catalystContribution ?? 0;
      return { ...row, available: c > 0, rankHint: c > 0 ? Math.round(c * 100) : null, why: c > 0 ? 'NewsCatalystStore has a contribution.' : 'No catalyst recorded.', impact: 'News does not independently vote BUY/SELL by default.', howToFix: 'Wait for a real NEWS_CATALYST event.' };
    }
    if (row.detector === 'feature_rs_spy') {
      return {
        ...row,
        available: typeof input.relativeStrengthVsSpy === 'number',
        rankHint: typeof input.relativeStrengthVsSpy === 'number' ? Math.round((input.relativeStrengthVsSpy + 1) * 50) : null,
        why: typeof input.relativeStrengthVsSpy === 'number' ? `RS vs SPY ${input.relativeStrengthVsSpy}` : 'Relative strength not computed.',
        impact: 'Context only.',
        howToFix: 'Ensure SPY bars exist in HistoricalDataGateway.',
      };
    }
    return {
      ...row,
      available: false,
      rankHint: null,
      why: `Detector ${row.detector} did not match the current evaluation.`,
      impact: 'Not used this cycle.',
      howToFix: 'No action unless this setup is the intended strategy.',
    };
  });
  ranked.sort((a, b) => (b.rankHint ?? -1) - (a.rankHint ?? -1));
  return { ranked, unavailableCount: ranked.filter((r) => !r.available).length };
}

export function setupCatalog(): SetupCatalogRow[] {
  return catalog.setups;
}
