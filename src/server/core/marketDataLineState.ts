/**
 * Market-data line state (2026-09-20 forensic-audit remediation, part C).
 *
 * Real, verified defect: `session-report`/`getActiveSlots()` could show "90/90 active symbols"
 * while zero of them were receiving any usable price - allocation (a `reqMktData` call was made)
 * was being conflated with entitlement (IBKR actually grants the data) and reception (a tick has
 * actually arrived recently). This module makes that distinction explicit and derivable from
 * already-existing MarketDataWorker signals - no new tracking mechanism, no new subscription
 * behavior, purely a read-only classification of state that already exists.
 *
 * `contractResolution`/`historyReady`/`featureReady` are reported as separate, orthogonal fields
 * rather than folded into one enum, because they are not mutually exclusive with the primary
 * data-line state (a symbol can be RECEIVING with an unresolved contract, or FRESH with unknown
 * history-readiness) - collapsing them into one enum would either lose information or fabricate a
 * precedence this codebase has no real evidence for. `historyReady`/`featureReady` are left
 * `'UNKNOWN'` unless a caller that actually owns that signal (HistoricalDataGateway / the quant
 * pipeline's own dataQuality check) supplies it - this module does not invent a new per-symbol
 * history/feature tracker.
 */
import { evaluateQuoteFreshness } from './marketDataQuality';

export type MarketDataLineState =
  | 'REQUESTED'
  | 'SUBSCRIPTION_ACTIVE'
  | 'ERROR'
  | 'RECEIVING_STALE'
  | 'RECEIVING_FRESH';

export type ReadinessTriState = 'YES' | 'NO' | 'UNKNOWN';

export interface MarketDataLineInput {
  /** Null = this worker has no local record of ever having requested this symbol. */
  subscribedAtMs: number | null;
  tickCount: number;
  latestPriceAgeMs: number | null;
  marketDataError: { code: number; message: string; atMs: number } | null;
}

export interface MarketDataLineDiagnostic {
  state: MarketDataLineState;
  /** True whenever tickCount > 0, regardless of freshness - "has this line ever produced usable
   *  data", independent of whether the most recent tick is still within the freshness window. */
  receiving: boolean;
  contractResolution: ReadinessTriState;
  historyReady: ReadinessTriState;
  featureReady: ReadinessTriState;
}

/**
 * Precedence (most to least specific): a recorded IBKR error always reported as ERROR even if a
 * tick arrived before the error (the error is the more actionable fact); otherwise freshness of
 * the most recent tick; otherwise whether a subscribe attempt is locally on record at all.
 */
export function deriveMarketDataLineState(
  input: MarketDataLineInput,
  opts: { contractResolution?: ReadinessTriState; historyReady?: ReadinessTriState; featureReady?: ReadinessTriState } = {},
): MarketDataLineDiagnostic {
  const receiving = input.tickCount > 0;
  const base = {
    receiving,
    contractResolution: opts.contractResolution ?? 'UNKNOWN',
    historyReady: opts.historyReady ?? 'UNKNOWN',
    featureReady: opts.featureReady ?? 'UNKNOWN',
  };

  if (input.marketDataError) return { ...base, state: 'ERROR' };
  if (receiving) {
    const fresh = evaluateQuoteFreshness({ priceAgeMs: input.latestPriceAgeMs }).passed;
    return { ...base, state: fresh ? 'RECEIVING_FRESH' : 'RECEIVING_STALE' };
  }
  if (input.subscribedAtMs !== null) return { ...base, state: 'SUBSCRIPTION_ACTIVE' };
  return { ...base, state: 'REQUESTED' };
}

export interface MarketDataLineSummary {
  allocatedLines: number;
  receivingLines: number;
  freshLines: number;
  staleLines: number;
  errorLines: number;
  entitlementFailures: number;
  contractFailures: number;
  bySymbol: Record<string, MarketDataLineDiagnostic>;
}

/** IBKR error codes this deployment has confirmed are entitlement/account-level rejections
 *  (354, 10089 - see docs/audits/ARGUS_IBKR_MARKET_DATA_FORENSIC_2026-09-20 findings), as opposed
 *  to contract-resolution failures (200) or session conflicts (10197, tracked separately - never
 *  counted as an entitlement or contract failure). */
const ENTITLEMENT_ERROR_CODES = new Set([354, 10089]);
const CONTRACT_ERROR_CODES = new Set([200]);

/** Aggregates per-symbol diagnostics into the counts required for honest capacity-vs-entitlement
 *  reporting. `lines` should come from MarketDataWorker.getActiveSlots() (already real, already
 *  persisted per-symbol tickCount/marketDataError) plus getLatestPriceAgeMs per symbol - this
 *  function does no I/O itself, purely aggregates what the caller already fetched. */
export function summarizeMarketDataLines(
  lines: Array<{ symbol: string; input: MarketDataLineInput; contractResolution?: ReadinessTriState }>,
): MarketDataLineSummary {
  const bySymbol: Record<string, MarketDataLineDiagnostic> = {};
  let receivingLines = 0;
  let freshLines = 0;
  let staleLines = 0;
  let errorLines = 0;
  let entitlementFailures = 0;
  let contractFailures = 0;

  for (const { symbol, input, contractResolution } of lines) {
    const diag = deriveMarketDataLineState(input, { contractResolution });
    bySymbol[symbol] = diag;
    if (diag.receiving) receivingLines++;
    if (diag.state === 'RECEIVING_FRESH') freshLines++;
    if (diag.state === 'RECEIVING_STALE') staleLines++;
    if (diag.state === 'ERROR') {
      errorLines++;
      const code = input.marketDataError?.code;
      if (code != null && ENTITLEMENT_ERROR_CODES.has(code)) entitlementFailures++;
      if (code != null && CONTRACT_ERROR_CODES.has(code)) contractFailures++;
    }
  }

  return {
    allocatedLines: lines.length,
    receivingLines,
    freshLines,
    staleLines,
    errorLines,
    entitlementFailures,
    contractFailures,
    bySymbol,
  };
}
