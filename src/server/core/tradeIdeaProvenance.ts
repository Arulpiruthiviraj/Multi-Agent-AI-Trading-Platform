/**
 * Canonical trade-idea provenance (Quant-First Decision Architecture, 2026-10-07).
 *
 * Every TRADE_IDEA_GENERATED idea carries an `origin` describing WHERE THE IDEA CAME FROM.
 * Provenance is descriptive, never authoritative: an emitter tagging its own idea
 * `origin: 'QUANT_STRATEGY'` does NOT grant it quant execution authority. Authority is
 * determined centrally by QuantStrategyAuthorization, which independently verifies the
 * strategyId against the canonical strategy registry (StrategyEngine.findStrategy) and the
 * DB-backed strategy lifecycle (StrategyEmissionEligibility) before ChiefTrader will ever
 * route an idea to QuantExecutionPolicy.
 *
 * Fail-closed default: missing, malformed, or unrecognized origin normalizes to 'OTHER',
 * which always resolves to REQUIRES_CONSENSUS - never to quant authority.
 *
 * Pure module: no imports, no I/O, safe to call from gateTradeIdea() and ChiefTraderAgent.
 */
export type TradeIdeaOrigin =
  | 'QUANT_STRATEGY'
  | 'TECHNICAL'
  | 'FORECAST'
  | 'NEWS_EVENT'
  | 'MACRO'
  | 'FUNDAMENTAL'
  | 'AI_RESEARCH'
  | 'PORTFOLIO_EXIT'
  | 'FAST_OPPORTUNITY_LANE'
  | 'EXPERIMENTAL'
  | 'OTHER';

const KNOWN_ORIGINS: ReadonlySet<string> = new Set<string>([
  'QUANT_STRATEGY',
  'TECHNICAL',
  'FORECAST',
  'NEWS_EVENT',
  'MACRO',
  'FUNDAMENTAL',
  'AI_RESEARCH',
  'PORTFOLIO_EXIT',
  'FAST_OPPORTUNITY_LANE',
  'EXPERIMENTAL',
  'OTHER',
]);

/**
 * Normalize a caller-supplied origin to the canonical enum. Anything unrecognized -
 * including a deliberate 'QUANT_VALIDATED' string (which is not a valid origin and never
 * was) - becomes 'OTHER', i.e. consensus-required, never quant-authorized.
 */
export function normalizeTradeIdeaOrigin(raw: unknown): TradeIdeaOrigin {
  if (typeof raw === 'string' && KNOWN_ORIGINS.has(raw)) {
    return raw as TradeIdeaOrigin;
  }
  return 'OTHER';
}

/**
 * Origins whose ideas may carry a strategyId claiming quant provenance. This is a
 * necessary-but-not-sufficient condition for quant authority: the central authorization
 * resolver must still independently verify strategy identity, producer, lifecycle, and
 * environment. Deliberately narrow - only strategy-backed quant emission qualifies.
 */
export function isQuantClaimingOrigin(origin: TradeIdeaOrigin): boolean {
  return origin === 'QUANT_STRATEGY';
}
