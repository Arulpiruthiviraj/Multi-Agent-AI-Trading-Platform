/**
 * Market-data diagnostics report (2026-09-20, delayed-data observability follow-up).
 *
 * Read-only composition over MarketDataWorker's already-real per-symbol state
 * (marketDataLineState.ts's summarizeMarketDataLines) plus the live/delayed quote stores and the
 * IBKR contract-resolution cache. This module does not track any new state itself, does not call
 * IBKR, and cannot mutate either the live or delayed quote store - it only reads.
 *
 * Exists specifically to answer, externally and without adding per-tick logging: is IBKR actually
 * sending delayed ticks (fields 66-69) under the current entitlement/session state, and is that
 * data staying fully isolated from the live trading path. See MarketDataWorker.getDelayedQuote()'s
 * own header for why delayed data is tracked per-field (bid/ask/last/close) rather than one
 * overwriting "latest tick" slot.
 */
import { marketDataWorker } from '../services/MarketDataWorker';
import { getCachedIbkrContractResolution } from '../../brokers/ibkrContractResolution';
import { summarizeMarketDataLines, type MarketDataLineSummary, type ReadinessTriState } from '../core/marketDataLineState';

/** 2026-09-21 Phase 2: structural shape of IbkrSocketSession's SubscriptionRecord, redeclared here
 *  (not imported) so this observability module never depends on the broker layer's internal types -
 *  same "read what MarketDataWorker.getIbkrSubscriptionState() actually returns" contract as the
 *  rest of this file already uses for delayed quotes / errors. Fields absent when the active
 *  backend isn't IBKR-backed or hasn't tracked this symbol at all. */
export interface IbkrSubscriptionStateShape {
  state: string;
  tickerId: number | null;
  generation: number;
  lastRequestAt: number | null;
  lastAcknowledgedAt: number | null;
  acknowledgementKind: string | null;
  marketDataType: number | null;
  retryCount: number;
  nextRetryAt: number | null;
  lastInternalFailureKind: string | null;
}

export interface SymbolMarketDataDiagnostic {
  symbol: string;
  desired: boolean;
  marketDataLineState: string;
  /** 2026-09-21 Phase 2: the real IBKR subscription lifecycle state (REQUESTING/ACKNOWLEDGED/
   *  ACTIVE/RETRY_WAIT/...), UNKNOWN when the active backend isn't IBKR-backed or hasn't tracked
   *  this symbol. This is what closes the "SUBSCRIPTION_ACTIVE shown while lifecycle says
   *  RETRY_WAIT" gap the post-fix adversarial audit found - see reconciledStatus below. */
  lifecycleState: string;
  tickerId: number | null;
  generation: number | null;
  lastRequestAt: number | null;
  lastAcknowledgedAt: number | null;
  acknowledgementKind: string | null;
  marketDataType: number | null;
  liveQuote: { price: number; ageMs: number } | null;
  delayedQuote: {
    bid: { price: number; ageMs: number } | null;
    ask: { price: number; ageMs: number } | null;
    last: { price: number; ageMs: number } | null;
    close: { price: number; ageMs: number } | null;
    latestAgeMs: number | null;
    dataMode: 'DELAYED';
    isLive: false;
  } | null;
  /** Broker-issued IBKR error code ONLY (354/10089/200/10197/...) - never a synthetic/internal
   *  value. See lastInternalFailureKind for ARGUS-generated conditions (e.g. NO_ACKNOWLEDGEMENT). */
  latestError: { code: number; message: string; atMs: number } | null;
  lastInternalFailureKind: string | null;
  retryCount: number | null;
  nextRetryAt: number | null;
  /** 2026-09-21 Phase 2: a single honest reconciled status - the answer to "what is really
   *  happening with this symbol" combining lifecycleState + marketDataLineState + reception, so a
   *  reader never has to reconcile two potentially-disagreeing fields by hand. */
  reconciledStatus: string;
  contractResolution: ReadinessTriState;
  historyReady: ReadinessTriState;
  featureReady: ReadinessTriState;
}

export interface MarketDataDiagnosticsReport {
  generatedAt: string;
  summary: MarketDataLineSummary;
  /** 2026-09-21 Phase 2: account-wide entitlement circuit-breaker snapshot, UNKNOWN/null when the
   *  active backend isn't IBKR-backed. */
  accountEntitlement: { state: string; canarySymbols: readonly string[]; degradedCanaries: readonly string[] } | null;
  symbols: SymbolMarketDataDiagnostic[];
}

/** 2026-09-21 Phase 2: the single reconciliation point section 12 of the hardening mandate
 *  requires - never lets the older, coarser marketDataLineState (REQUESTED/SUBSCRIPTION_ACTIVE/...)
 *  stand alone when the real IBKR lifecycle record disagrees with it. Pure function of already-
 *  computed inputs; invents nothing. */
export function reconcileStatus(lineState: string, lifecycle: IbkrSubscriptionStateShape | null): string {
  if (!lifecycle) return lineState; // no IBKR lifecycle evidence at all (non-IBKR backend, or never tracked) - the older classification is all there is
  switch (lifecycle.state) {
    case 'RETRY_WAIT':
    case 'REJECTED_RETRYABLE':
      return 'RETRY_WAIT';
    case 'REJECTED_NONRETRYABLE':
      return 'REJECTED_NONRETRYABLE';
    case 'REQUESTING':
      return lifecycle.lastInternalFailureKind === 'NO_ACKNOWLEDGEMENT' ? 'REQUESTING_UNCONFIRMED' : 'REQUESTING';
    case 'ACKNOWLEDGED':
      return 'ACKNOWLEDGED_WAITING_FOR_DATA';
    case 'ACTIVE':
      // A real tick has been seen at least once - defer to the freshness-aware lineState
      // (RECEIVING_FRESH/RECEIVING_STALE) rather than the coarser "ACTIVE".
      return lineState === 'RECEIVING_FRESH' || lineState === 'RECEIVING_STALE' ? lineState : 'ACTIVE';
    default:
      return lineState;
  }
}

/** Pure composition — every field is read, nothing is written. Safe to call at any time,
 *  including while trading is paused; has no side effects on any store. */
export function buildMarketDataDiagnosticsReport(requestedSymbols?: string[]): MarketDataDiagnosticsReport {
  const symbols = requestedSymbols && requestedSymbols.length > 0
    ? requestedSymbols.map((s) => s.toUpperCase())
    : marketDataWorker.getActiveSymbols();

  const lines = symbols.map((symbol) => {
    const resolution = getCachedIbkrContractResolution(symbol);
    const contractResolution: ReadinessTriState =
      resolution == null ? 'UNKNOWN' : resolution.status === 'RESOLVED' ? 'YES' : 'NO';
    return {
      symbol,
      contractResolution,
      input: {
        subscribedAtMs: marketDataWorker.getSubscribedAtMs(symbol),
        tickCount: marketDataWorker.getTickCount(symbol),
        latestPriceAgeMs: marketDataWorker.getLatestPriceAgeMs(symbol),
        marketDataError: marketDataWorker.getMarketDataError(symbol),
      },
    };
  });
  const summary = summarizeMarketDataLines(lines);

  const symbolDiagnostics: SymbolMarketDataDiagnostic[] = symbols.map((symbol) => {
    const livePrice = marketDataWorker.getLatestPrice(symbol);
    const liveAgeMs = marketDataWorker.getLatestPriceAgeMs(symbol);
    const delayed = marketDataWorker.getDelayedQuote(symbol);
    const lineState = summary.bySymbol[symbol]?.state ?? 'REQUESTED';
    const lifecycle = marketDataWorker.getIbkrSubscriptionState(symbol) as IbkrSubscriptionStateShape | null;
    return {
      symbol,
      desired: true, // this report only ever iterates MarketDataWorker's own tracked/desired symbol set
      marketDataLineState: lineState,
      lifecycleState: lifecycle?.state ?? 'UNKNOWN',
      tickerId: lifecycle?.tickerId ?? null,
      generation: lifecycle?.generation ?? null,
      lastRequestAt: lifecycle?.lastRequestAt ?? null,
      lastAcknowledgedAt: lifecycle?.lastAcknowledgedAt ?? null,
      acknowledgementKind: lifecycle?.acknowledgementKind ?? null,
      marketDataType: lifecycle?.marketDataType ?? null,
      liveQuote: livePrice !== null && liveAgeMs !== null ? { price: livePrice, ageMs: liveAgeMs } : null,
      delayedQuote: delayed ? {
        bid: delayed.bid ? { price: delayed.bid.price, ageMs: delayed.bid.ageMs } : null,
        ask: delayed.ask ? { price: delayed.ask.price, ageMs: delayed.ask.ageMs } : null,
        last: delayed.last ? { price: delayed.last.price, ageMs: delayed.last.ageMs } : null,
        close: delayed.close ? { price: delayed.close.price, ageMs: delayed.close.ageMs } : null,
        latestAgeMs: delayed.latestAgeMs,
        dataMode: 'DELAYED',
        isLive: false,
      } : null,
      latestError: marketDataWorker.getMarketDataError(symbol),
      lastInternalFailureKind: lifecycle?.lastInternalFailureKind ?? null,
      retryCount: lifecycle?.retryCount ?? null,
      nextRetryAt: lifecycle?.nextRetryAt ?? null,
      reconciledStatus: reconcileStatus(lineState, lifecycle),
      contractResolution: summary.bySymbol[symbol]?.contractResolution ?? 'UNKNOWN',
      // No cheap, honest per-symbol synchronous signal exists in this codebase for these two -
      // see marketDataLineState.ts's own header. UNKNOWN is the correct answer, never fabricated.
      historyReady: 'UNKNOWN',
      featureReady: 'UNKNOWN',
    };
  });

  const rawEntitlement = marketDataWorker.getIbkrAccountEntitlementState() as
    { state: string; canarySymbols: readonly string[]; degradedCanaries: readonly string[] } | null;

  return {
    generatedAt: new Date().toISOString(),
    summary,
    accountEntitlement: rawEntitlement,
    symbols: symbolDiagnostics,
  };
}

export function formatMarketDataDiagnosticsReport(report: MarketDataDiagnosticsReport): string {
  const lines = [
    'MARKET-DATA DIAGNOSTICS (allocation vs entitlement vs reception - read-only, no mutation)',
    '-------------------------------------------------------------------------------------------',
    `Generated: ${report.generatedAt}`,
    '',
    `Allocated: ${report.summary.allocatedLines}  Receiving: ${report.summary.receivingLines}  `
    + `Fresh: ${report.summary.freshLines}  Stale: ${report.summary.staleLines}  Error: ${report.summary.errorLines}`,
    `Entitlement failures (354/10089): ${report.summary.entitlementFailures}  Contract failures (200): ${report.summary.contractFailures}`,
    '',
  ];
  if (report.accountEntitlement) {
    lines.push(
      `Account entitlement state: ${report.accountEntitlement.state}`
      + (report.accountEntitlement.degradedCanaries.length > 0
        ? ` (degraded canaries: ${report.accountEntitlement.degradedCanaries.join(', ')} of ${report.accountEntitlement.canarySymbols.join(', ')})`
        : ` (canaries: ${report.accountEntitlement.canarySymbols.join(', ')})`),
    );
    lines.push('');
  }
  if (report.symbols.length === 0) {
    lines.push('(no symbols allocated)');
    return lines.join('\n');
  }
  lines.push(
    'Symbol'.padEnd(8) + 'ReconciledStatus'.padEnd(24) + 'Lifecycle'.padEnd(15) + 'LineState'.padEnd(18)
    + 'LiveAgeMs'.padEnd(11) + 'AckKind'.padEnd(15) + 'MDT'.padEnd(5) + 'InternalFail'.padEnd(18)
    + 'Retry#'.padEnd(7) + 'DelayedBid'.padEnd(12) + 'DelayedAsk'.padEnd(12) + 'DelayedLast'.padEnd(13)
    + 'DelayedClose'.padEnd(14) + 'LastError',
  );
  for (const s of report.symbols) {
    const fmt = (v: { price: number } | null) => v ? v.price.toFixed(2) : '-';
    lines.push(
      s.symbol.padEnd(8)
      + s.reconciledStatus.padEnd(24)
      + s.lifecycleState.padEnd(15)
      + s.marketDataLineState.padEnd(18)
      + String(s.liveQuote?.ageMs ?? '-').padEnd(11)
      + String(s.acknowledgementKind ?? '-').padEnd(15)
      + String(s.marketDataType ?? '-').padEnd(5)
      + String(s.lastInternalFailureKind ?? '-').padEnd(18)
      + String(s.retryCount ?? '-').padEnd(7)
      + fmt(s.delayedQuote?.bid ?? null).padEnd(12)
      + fmt(s.delayedQuote?.ask ?? null).padEnd(12)
      + fmt(s.delayedQuote?.last ?? null).padEnd(13)
      + fmt(s.delayedQuote?.close ?? null).padEnd(14)
      + (s.latestError ? `code=${s.latestError.code}` : '-'),
    );
  }
  return lines.join('\n');
}
