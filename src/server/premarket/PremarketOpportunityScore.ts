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
 *   repo's Java Engine Authority rule it stays in TypeScript. (Java owns new
 *   quant/indicator/strategy compute; this module only weights and ranks
 *   already-computed evidence into an attention ordering — the same
 *   orchestration layer ComposableRanking.ts already occupies.)
 *
 * Sentiment ceiling (documented, tested): the signedSentiment component is the
 * raw signed value sentiment * confidence clamped to [-1,1], so its total
 * contribution is bounded by +/- weights.signedSentiment (config
 * sentimentAloneCeiling, validated equal at load). Extreme sentiment with no
 * other evidence can never push the total above that ceiling, and the
 * breakdown deliberately carries no side/direction field — sentiment adjusts
 * attention, it never triggers direction.
 *
 * Spread semantics: spreadBps === null means "explicitly unknown" and is
 * fail-open (scores 1.0, neutral — matches the input's own documented
 * semantics); spreadBps === undefined means "not supplied" and scores 0 with
 * 'spreadBps' listed in inputsMissing.
 */

import { premarketFocusConfig } from '../config/premarketFocus';

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

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function clampSigned(x: number): number {
  return Math.max(-1, Math.min(1, x));
}

function isPresentNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Score one pre-market candidate with a fully decomposed breakdown.
 *
 * Workstream B: call inside try/catch; on throw, fall back to the existing
 * ranking path and mark the plan UNCHANGED_NO_NEW_EVIDENCE where appropriate.
 *
 * Every component is computed from real inputs only. A component with no input
 * scores 0 and its input name is appended to inputsMissing — a real zero and
 * "no data" are never conflated (same evidence-aware discipline as
 * ComposableRanking.ts). Gap and pre-market move are scored on magnitude
 * (direction-blind): this is an attention ranking, not a direction signal.
 */
export function scorePremarketCandidate(input: PremarketCandidateInput): PremarketScoreBreakdown {
  const cfg = premarketFocusConfig;
  const weights = cfg.weights;
  const available: string[] = ['dataFresh'];
  const missing: string[] = [];

  // Overnight gap — direction-blind magnitude: a -4% gap deserves as much
  // pre-market attention as a +4% gap. Missing -> 0, honestly listed.
  let overnightGap = 0;
  if (isPresentNumber(input.overnightGapPct)) {
    overnightGap = clamp01(Math.abs(input.overnightGapPct) / cfg.scales.gapScaleCapPct);
    available.push('overnightGapPct');
  } else {
    missing.push('overnightGapPct');
  }

  // Pre-market session move — same direction-blind treatment as the gap.
  let preMarketPctChange = 0;
  if (isPresentNumber(input.preMarketPctChange)) {
    preMarketPctChange = clamp01(Math.abs(input.preMarketPctChange) / cfg.scales.preMarketScaleCapPct);
    available.push('preMarketPctChange');
  } else {
    missing.push('preMarketPctChange');
  }

  // Catalyst trio: presence (binary), recency (linear decay), signed sentiment
  // (contextual: sentiment * confidence, may dampen the total, never a trigger).
  const catalyst = input.catalyst ?? null;
  let catalystPresence = 0;
  let catalystRecency = 0;
  let signedSentiment = 0;
  if (catalyst !== null) {
    catalystPresence = 1;
    catalystRecency = clamp01(1 - Math.max(0, catalyst.recencyMinutes) / cfg.scales.catalystRecencyZeroAtMinutes);
    signedSentiment = clampSigned(catalyst.sentiment * clamp01(catalyst.confidence));
    available.push('catalyst');
  } else {
    missing.push('catalyst');
  }

  // Liquidity — best of the two honest volume measures; both absent -> 0.
  // (advShares cannot be converted to dollars without a price this input does
  // not carry, so each measure is normalized against its own config cap.)
  const liquidityScores: number[] = [];
  if (isPresentNumber(input.dollarVolume)) {
    liquidityScores.push(clamp01(input.dollarVolume / cfg.scales.liquidityScaleDollars));
    available.push('dollarVolume');
  } else {
    missing.push('dollarVolume');
  }
  if (isPresentNumber(input.advShares)) {
    liquidityScores.push(clamp01(input.advShares / cfg.scales.advLiquidityScaleShares));
    available.push('advShares');
  } else {
    missing.push('advShares');
  }
  const liquidity = liquidityScores.length > 0 ? Math.max(...liquidityScores) : 0;

  // Spread quality — null (explicitly unknown) is fail-open per the input's own
  // documented semantics: neutral 1.0, not penalized, not listed missing.
  // undefined (not supplied at all) is honestly missing.
  let spreadQuality: number;
  if (input.spreadBps === undefined) {
    spreadQuality = 0;
    missing.push('spreadBps');
  } else if (input.spreadBps === null) {
    spreadQuality = 1;
    available.push('spreadBps');
  } else if (isPresentNumber(input.spreadBps)) {
    spreadQuality = clamp01(1 - Math.max(0, input.spreadBps) / cfg.scales.spreadZeroAtBps);
    available.push('spreadBps');
  } else {
    spreadQuality = 0;
    missing.push('spreadBps');
  }

  // Sector / market relative strength — callers supply an already-normalized
  // 0..1 strength; clamped, never rescaled against an invented distribution.
  // (ComposableRanking documents why sector-basket evidence is often honestly
  // unavailable from this deployment's feeds.)
  let sectorRelativeStrength = 0;
  if (isPresentNumber(input.sectorRelativeStrength)) {
    sectorRelativeStrength = clamp01(input.sectorRelativeStrength);
    available.push('sectorRelativeStrength');
  } else {
    missing.push('sectorRelativeStrength');
  }

  let marketRelativeStrength = 0;
  if (isPresentNumber(input.marketRelativeStrength)) {
    marketRelativeStrength = clamp01(input.marketRelativeStrength);
    available.push('marketRelativeStrength');
  } else {
    missing.push('marketRelativeStrength');
  }

  // Strategy applicability — count of strategies with a valid pre-market
  // setup, normalized by config. An explicitly empty array is a real 0
  // (no applicable strategies), not missing data.
  let strategyApplicability = 0;
  if (input.strategyApplicability == null) {
    missing.push('strategyApplicability');
  } else {
    strategyApplicability = clamp01(input.strategyApplicability.length / cfg.scales.strategyFullCount);
    available.push('strategyApplicability');
  }

  const components: PremarketScoreComponents = {
    overnightGap,
    preMarketPctChange,
    catalystPresence,
    catalystRecency,
    signedSentiment,
    liquidity,
    spreadQuality,
    sectorRelativeStrength,
    marketRelativeStrength,
    strategyApplicability,
  };

  // signedSentiment is signed: a strongly negative catalyst can dampen the
  // total. Clamp keeps the total in [0,1]; the upper bound cannot exceed 1
  // because weights sum to 1 and every non-sentiment component is in [0,1].
  const rawTotal =
    weights.overnightGap * components.overnightGap +
    weights.preMarketPctChange * components.preMarketPctChange +
    weights.catalystPresence * components.catalystPresence +
    weights.catalystRecency * components.catalystRecency +
    weights.signedSentiment * components.signedSentiment +
    weights.liquidity * components.liquidity +
    weights.spreadQuality * components.spreadQuality +
    weights.sectorRelativeStrength * components.sectorRelativeStrength +
    weights.marketRelativeStrength * components.marketRelativeStrength +
    weights.strategyApplicability * components.strategyApplicability;
  const total = clamp01(rawTotal);

  return {
    symbol: input.symbol,
    components,
    total,
    weights: { ...weights },
    scoredAt: new Date().toISOString(),
    inputsAvailable: available,
    inputsMissing: missing,
  };
}
