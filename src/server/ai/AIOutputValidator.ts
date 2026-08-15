/**
 * ==========================================================
 * Module: AIOutputValidator.ts
 *
 * Hardening pass, Phase 5 (AI output validation). Every site that parses a structured JSON
 * response from an LLM (NewsScoringEngine, FundamentalAgent, MacroAgent, AIRouter's own
 * consensus-debate parse) previously did `JSON.parse(text)` and used the result directly, with no
 * runtime check that the AI actually returned the field types/ranges/enum values its own prompt
 * asked for. Confirmed real, not theoretical: FundamentalAgent/MacroAgent pass
 * `analysis.recommendation` straight through as a real `TRADE_IDEA_GENERATED` `side` with no enum
 * check, and NewsEngine.ts's `aiAnalysis.tradingBias === 'BULLISH' ? 'BUY' : 'SELL'` means any
 * off-schema tradingBias value (a typo, wrong case, or a value the model invented) silently
 * resolves to SELL - the AI's actual sentiment is ignored, not merely unvalidated.
 *
 * This module sits strictly between "AI proposes" and "deterministic engines calculate" - it only
 * coerces/clamps/defaults a parsed AI response into the shape its own prompt already promised; it
 * never invents a value the AI didn't provide in some form, and it never touches RiskEngine or any
 * other gate. An AI response that fails validation degrades to a safe default (HOLD/NEUTRAL/0
 * confidence), never a fabricated BUY/SELL.
 * ==========================================================
 */

// Case-insensitive match against a fixed enum, e.g. "buy", " Buy ", "BUY" all resolve to "BUY".
// Anything that doesn't match one of the allowed values (including non-strings, or a value the
// model invented that isn't in the schema) falls back to the safe default.
export function coerceEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  const upper = raw.trim().toUpperCase();
  const match = allowed.find(a => a.toUpperCase() === upper);
  return match ?? fallback;
}

function toFiniteNumber(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Clamps a numeric field to [min, max], coercing a numeric string if needed. Falls back cleanly
// on anything non-numeric (missing field, wrong type, "high"/"N/A", NaN/Infinity).
export function clampScore(raw: unknown, min: number, max: number, fallback: number): number {
  const n = toFiniteNumber(raw);
  if (n === null) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Normalizes a confidence value onto this codebase's real 0-1 TRADE_IDEA_GENERATED convention
// (CLAUDE.md: "confidence (0-1)"). Some agent prompts (FundamentalAgent/MacroAgent) don't specify
// a scale at all, and models answer on either 0-1 or 0-100 - anything above 1 is treated as a
// 0-100 answer and normalized down, rather than clamped to 1.0 (which would flatten every
// 0-100-scale answer to maximum confidence regardless of what the model actually said).
export function normalizeConfidence01(raw: unknown, fallback = 0): number {
  const n = toFiniteNumber(raw);
  if (n === null) return fallback;
  const normalized = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, normalized));
}

export function coerceString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

export function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

export const TRADE_SIDE_VALUES = ['BUY', 'SELL', 'HOLD'] as const;
export type TradeSide = typeof TRADE_SIDE_VALUES[number];

export const TRADING_BIAS_VALUES = ['BULLISH', 'BEARISH', 'NEUTRAL'] as const;
export type TradingBias = typeof TRADING_BIAS_VALUES[number];

/**
 * Phase 16G - a listed US equity ticker is 1-5 letters, optional share-class suffix (BRK.B).
 * Company names, parenthetical fragments, and free text the news LLM invented ("(Coca-Cola)",
 * "Sysco") are not tickers and must not reach ChiefTrader as a tradeable symbol.
 */
export function looksLikeListedTicker(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(s)) return null;
  return s;
}

/**
 * Phase 16G - if an AI claims a spot price that disagrees with live market data by more than
 * `maxDeviationPct` (default 2%), the AI number is rejected. The live price is never overwritten
 * by the AI claim. Returns {accepted:false} when the claim is unusable - callers must then ignore
 * the AI price, not invent a substitute.
 */
export function rejectIfPriceDisagrees(
  claimedPrice: unknown,
  livePrice: number | null | undefined,
  maxDeviationPct = 2,
): { accepted: boolean; reason: string | null } {
  const claimed = typeof claimedPrice === 'number' ? claimedPrice
    : typeof claimedPrice === 'string' ? parseFloat(claimedPrice) : NaN;
  if (!Number.isFinite(claimed) || claimed <= 0) {
    return { accepted: false, reason: 'AI claimed price is missing or non-numeric.' };
  }
  if (livePrice === null || livePrice === undefined || !Number.isFinite(livePrice) || livePrice <= 0) {
    return { accepted: false, reason: 'No live market price available to validate the AI claim against.' };
  }
  const deviationPct = Math.abs(claimed - livePrice) / livePrice * 100;
  if (deviationPct > maxDeviationPct) {
    return { accepted: false, reason: `AI claimed price ${claimed} disagrees with live ${livePrice} by ${deviationPct.toFixed(2)}% (max ${maxDeviationPct}%).` };
  }
  return { accepted: true, reason: null };
}
