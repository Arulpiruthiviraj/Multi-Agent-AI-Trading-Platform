/**
 * ==========================================================
 * Module: ai/QuantContradictionAnalyzer
 *
 * Purpose:
 * Phase 7 of the additive quant layer - "AI Integration." Per the plan's own explicit rules:
 *   - "AI should consume structured deterministic features rather than independently recreating
 *     calculations." This module's prompt is built entirely from already-computed Phase 2/4/6
 *     output (RegimeResult, StrategyEvaluation, GroupedScores) - it never re-sends raw bars or asks
 *     the model to compute an indicator, regime, or score itself.
 *   - "AI must NOT overwrite deterministic calculations. If an AI model disagrees with a
 *     deterministic calculation, preserve both values and record the disagreement." Concretely:
 *     this function NEVER returns (or lets a caller derive) a new side/confidence/setupScore - the
 *     deterministic values the caller already has stay exactly as they are. The AI's own read is
 *     returned as a SEPARATE field (`aiAgreesWithSide`), and a real disagreement is recorded
 *     (`disagreementNote`), never used to flip or adjust the deterministic side/confidence.
 *   - Used specifically for "contextual reasoning, contradiction detection, ... scenario analysis,
 *     qualitative reasoning" (the plan's own list) - not for news/forecast interpretation, which
 *     belong to the real, separate NewsScoringEngine/KronosForecastAgent systems respectively (see
 *     GroupedScores.ts's header for why this module doesn't compute a newsScore/forecastScore).
 *
 * Degrades honestly (available:false, never a fabricated verdict) when no AI provider is
 * configured or the call fails - matches this codebase's own established pattern
 * (FundamentalAgent.ts/MacroAgent.ts's DATA_UNAVAILABLE framing), generalized to catch ANY
 * AIRouter failure rather than gating on one specific provider's env var, since AIRouter itself
 * may have other real providers configured even when GEMINI_API_KEY specifically is unset.
 * ==========================================================
 */
import { AIRouter } from '../../ai/AIRouter';
import { coerceEnum, coerceString, coerceStringArray } from '../../ai/AIOutputValidator';
import { RegimeResult } from '../RegimeEngine';
import { StrategyEvaluation } from '../strategies/types';
import { GroupedScores } from '../scoring/GroupedScores';

const ASSESSMENT_VALUES = ['AGREES', 'DISAGREES', 'UNCERTAIN'] as const;

export interface ContradictionAnalysisInput {
  symbol: string;
  side: 'BUY' | 'SELL';
  regime: RegimeResult;
  strategyEvaluation: StrategyEvaluation | null;
  groupedScores: GroupedScores;
}

export interface ContradictionAnalysisResult {
  available: boolean; // false = no AI provider configured or the call failed - never a fabricated verdict
  aiAgreesWithSide: boolean | null; // the AI's own independent qualitative read - null if UNCERTAIN or unavailable
  additionalContradictions: string[]; // real, NEW observations distinct from strategyEvaluation's own deterministic contradictions
  scenarioAnalysis: string;
  disagreementNote: string | null; // populated ONLY when the AI's read conflicts with the deterministic side - never changes that side
  reason?: string; // populated only when available:false, explaining why
  aiCallId?: string;
  provider?: string;
  latencyMs?: number;
}

function buildPrompt(input: ContradictionAnalysisInput): string {
  const { symbol, side, regime, strategyEvaluation, groupedScores } = input;
  return `You are reviewing a DETERMINISTIC quantitative trade assessment for ${symbol}. Every number below was already calculated by real, deterministic code - your job is qualitative review only, never to recompute or replace any of these values.

Proposed side: ${side}
Real market regime: ${regime.regime} (trendStrength ${regime.trendStrength}, volatility ${regime.volatility}, marketStructure ${regime.marketStructure}, confidence ${regime.confidence.toFixed(2)})
${strategyEvaluation ? `Real strategy: ${strategyEvaluation.strategy} (setupScore ${strategyEvaluation.setupScore}, confidence ${strategyEvaluation.confidence.toFixed(2)})
Conditions that held: ${strategyEvaluation.conditionsMet.join('; ') || 'none'}
Conditions that failed: ${strategyEvaluation.conditionsFailed.join('; ') || 'none'}
Contradictions already found deterministically: ${strategyEvaluation.contradictions.join('; ') || 'none'}` : 'No individual strategy setup cleared its confidence bar - this assessment is regime-derived only.'}
Grouped scores (0-100, 50=neutral, all already favor ${side}): trend ${groupedScores.trendScore}, momentum ${groupedScores.momentumScore}, volume ${groupedScores.volumeScore}, vwap ${groupedScores.vwapScore}, market ${groupedScores.marketScore}, sector ${groupedScores.sectorScore}, relativeStrength ${groupedScores.relativeStrengthScore}, priceStructure ${groupedScores.priceStructureScore}, overall ${groupedScores.overallSetupScore}

Your task, using only judgment/context on top of the real numbers above - do NOT invent new prices, scores, or indicator values:
1. Does this real evidence, taken as a whole, genuinely support or conflict with the ${side} call?
2. Any real additional contradiction or risk this data reveals that isn't already listed above?
3. A brief (2-3 sentence) scenario analysis.

Return strict JSON, no markdown: { "assessment": "AGREES" | "DISAGREES" | "UNCERTAIN", "additionalContradictions": ["..."], "scenarioAnalysis": "...", "disagreementReason": "..." }`;
}

export async function analyzeContradictions(input: ContradictionAnalysisInput, traceId: string): Promise<ContradictionAnalysisResult> {
  try {
    const res = await AIRouter.getInstance().routeTask('QuantContradictionAnalyzer', buildPrompt(input), traceId, true);
    let text = res.content.trim();
    if (text.startsWith('```json')) text = text.replace(/^```json\n/, '').replace(/\n```$/, '');
    else if (text.startsWith('```')) text = text.replace(/^```\n/, '').replace(/\n```$/, '');

    const raw = JSON.parse(text);
    const assessment = coerceEnum(raw.assessment, ASSESSMENT_VALUES, 'UNCERTAIN');
    const aiAgreesWithSide = assessment === 'AGREES' ? true : assessment === 'DISAGREES' ? false : null;

    return {
      available: true,
      aiAgreesWithSide,
      additionalContradictions: coerceStringArray(raw.additionalContradictions),
      scenarioAnalysis: coerceString(raw.scenarioAnalysis, 'No scenario analysis provided.'),
      // A real disagreement is recorded, never used to flip the deterministic side - the caller
      // still owns `input.side`/whatever confidence it already computed, unchanged by this result.
      disagreementNote: assessment === 'DISAGREES'
        ? coerceString(raw.disagreementReason, 'AI qualitative review disagrees with the deterministic side, but did not provide a specific reason.')
        : null,
      aiCallId: res.aiCallId,
      provider: res.provider,
      latencyMs: res.latency,
    };
  } catch (e: any) {
    return {
      available: false,
      aiAgreesWithSide: null,
      additionalContradictions: [],
      scenarioAnalysis: '',
      disagreementNote: null,
      reason: `AI contradiction analysis unavailable: ${e.message}`,
    };
  }
}
