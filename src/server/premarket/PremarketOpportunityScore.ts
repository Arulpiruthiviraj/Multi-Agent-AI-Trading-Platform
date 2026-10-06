/**
 * Pre-market opportunity score — decomposed candidate ranking for the pre-market
 * focus engine (2026-10-06, local-only).
 *
 * CONTRACT (stable): workstream B (late refresh) calls `scorePremarketCandidate`
 * during the ~09:00-09:15 ET refresh; workstream D implements the scoring math,
 * observability, and focus report in this module and PremarketFocusReport.ts.
 *
 * Design constraints (from the authorized brief):
 * - Every component is separately observable; no opaque blended number.
 * - signedSentiment is CONTEXTUAL evidence (-1..1), never a directional oracle:
 *   it must never be converted into positive=BUY / negative=SELL.
 * - Missing inputs are honest: they appear in `inputsAvailable` omissions and
 *   score 0 for that component; they are never fabricated.
 * - Score weights live in config (config/premarketFocus.json), never as TS
 *   literals (repo AGENTS.md: no hardcoded operational thresholds in TS).
 * - This is orchestration-layer candidate ranking (same layer as the existing
 *   ComposableRanking.ts), not a new indicator/strategy calculation: per the
 *   repo's Java Engine Authority rule it stays in TypeScript.
 */

export type SentimentSign = -1 | 0 | 1;

export interface PremarketCatalystInput {
  /** Signed FinBERT direction: -1 negative, 0 neutral, +1 positive. Context only. */
  sentiment: SentimentSign;
  /** FinBERT confidence 0..1. */
  confidence: number;
  /** Minutes since the catalyst timestamp; lower = fresher. */
  recencyMinutes: number;
  /** Provider/source name (e.g. 'rss:reuters', 'finbert'). */
  source: string;
  /** Direction-blind impact magnitude 0..1. */
  impactMagnitude: number;
}

export interface PremarketCandidateInput {
  symbol: string;
  /** Overnight gap %: (open - prevClose)/prevClose*100. Undefined when unavailable. */
  overnightGapPct?: number;
  /** Pre-market session move %. Undefined when unavailable. */
  preMarketPctChange?: number;
  /** Strongest current catalyst, if any. */
  catalyst?: PremarketCatalystInput | null;
  /** Recent dollar volume (for liquidity component). */
  dollarVolume?: number;
  /** 20-day average daily volume (shares). */
  advShares?: number;
  /** Current spread in bps; null = unknown (fail-open per existing semantics). */
  spreadBps?: number | null;
  /** Relative strength vs sector. Undefined when unavailable. */
  sectorRelativeStrength?: number;
  /** Relative strength vs market (SPY/QQQ). Undefined when unavailable. */
  marketRelativeStrength?: number;
  /** Strategy names with a valid pre-market setup. */
  strategyApplicability?: string[];
  /** Whether the candidate's quote/data is fresh right now. */
  dataFresh: boolean;
}

export interface PremarketScoreComponents {
  overnightGap: number; // 0..1
  preMarketPctChange: number; // 0..1
  catalystPresence: number; // 0..1
  catalystRecency: number; // 0..1
  signedSentiment: number; // -1..1 (contextual; may reduce the total, never triggers direction)
  liquidity: number; // 0..1
  spreadQuality: number; // 0..1
  sectorRelativeStrength: number; // 0..1
  marketRelativeStrength: number; // 0..1
  strategyApplicability: number; // 0..1
}

export interface PremarketScoreBreakdown {
  symbol: string;
  components: PremarketScoreComponents;
  /** Weighted total 0..1. Weights come from config/premarketFocus.json. */
  total: number;
  weights: Record<keyof PremarketScoreComponents, number>;
  scoredAt: string; // ISO
  /** Which inputs were actually present; absent inputs scored 0 honestly. */
  inputsAvailable: string[];
  inputsMissing: string[];
}

/**
 * Score one pre-market candidate with a fully decomposed breakdown.
 * Workstream D: replace this stub with the real implementation.
 * Workstream B: call inside try/catch; on throw, fall back to the existing
 * ranking path and mark the plan UNCHANGED_NO_NEW_EVIDENCE where appropriate.
 */
export function scorePremarketCandidate(_input: PremarketCandidateInput): PremarketScoreBreakdown {
  throw new Error('scorePremarketCandidate not yet implemented (workstream D)');
}
