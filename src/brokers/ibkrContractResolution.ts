/**
 * IBKR contract resolution (2026-09-20 forensic-audit remediation, part A).
 *
 * Real, verified defect: `IbkrSocketSession.stockContract()` always sent
 * `{symbol, secType:'STK', exchange:'SMART', currency:'USD'}` with no `primaryExchange`,
 * `localSymbol`, or `conId`, and never called `reqContractDetails()` to qualify it first. This is
 * fine for the overwhelming majority of symbols (SMART routing resolves them correctly - confirmed
 * live: IBKR's own error messages independently report the correct primary exchange for every
 * checked symbol, e.g. "AAPL NASDAQ.NMS/TOP/ALL", "SPY ARCA/TOP/ALL" - even without an explicit
 * primaryExchange field). It fails outright (IBKR error 200, "No security definition has been
 * found for the request") for symbols IBKR cannot uniquely resolve from the bare symbol string
 * alone - confirmed live for `BRK.B` (204 occurrences) and `SQ` (148 occurrences, the pre-2023
 * Block Inc. ticker - Block now trades as `XYZ`).
 *
 * This module does NOT hardcode a broad symbol->contract mapping table. It uses IBKR's own
 * `reqContractDetails()` to VERIFY every candidate contract shape before ever accepting it -
 * string transforms (e.g. "BRK.B" -> "BRK B") are only ever candidate INPUTS to real IBKR
 * verification, never assumed correct on their own. A candidate is accepted only when IBKR
 * returns EXACTLY ONE matching contract. Zero matches or more than one match both fail closed
 * (NOT_FOUND / AMBIGUOUS) - this module never guesses among multiple real IBKR contracts, and
 * never silently substitutes a different security.
 */
import type { Contract, ContractDetails } from '@stoqey/ib';
import type IBApi from '@stoqey/ib';
import { EventName, SecType } from '@stoqey/ib';

export interface ResolvedIbkrContract {
  symbol: string;
  secType: string;
  exchange: string;
  primaryExchange: string | null;
  currency: string;
  localSymbol: string | null;
  conId: number | null;
  resolvedAt: number;
  /** The candidate contract (post any string-transform heuristic) that IBKR actually accepted. */
  matchedCandidateSymbol: string;
}

export type ContractResolutionOutcome =
  | { status: 'RESOLVED'; contract: ResolvedIbkrContract }
  | { status: 'AMBIGUOUS'; symbol: string; candidateCount: number; resolvedAt: number }
  | { status: 'NOT_FOUND'; symbol: string; resolvedAt: number }
  | { status: 'ERROR'; symbol: string; message: string; resolvedAt: number };

/** In-memory only, matching this codebase's established pattern for fairness/observability-style
 *  overlay state (e.g. BroadUniverseSubscriptionAllocator.ts) - a resolved IBKR contract is not
 *  trading state, and safely resets to empty on restart (re-derived from IBKR on next need). */
const resolutionCache = new Map<string, ContractResolutionOutcome>();

export function getCachedIbkrContractResolution(symbol: string): ContractResolutionOutcome | null {
  return resolutionCache.get(symbol.toUpperCase()) ?? null;
}

export function resetIbkrContractResolutionCacheForTests(): void {
  resolutionCache.clear();
}

/**
 * Narrow, disclosed heuristic for building candidate contract symbols to VERIFY (never to accept
 * blindly). Only applied to symbols containing a `.` (share-class notation, e.g. "BRK.B",
 * "BRK.A") - IBKR's own contract symbol field commonly uses a space instead of a dot for these
 * ("BRK B"). The raw symbol is always tried FIRST; the space variant is only a fallback candidate
 * if the raw form does not uniquely resolve.
 */
export function buildCandidateContractSymbols(symbol: string): string[] {
  const sym = symbol.toUpperCase();
  const candidates = [sym];
  if (sym.includes('.')) {
    const spaced = sym.replace(/\./g, ' ');
    if (spaced !== sym) candidates.push(spaced);
  }
  return candidates;
}

function toResolvedContract(details: ContractDetails, matchedCandidateSymbol: string, now: number): ResolvedIbkrContract {
  const c = details.contract;
  return {
    symbol: (c.symbol ?? matchedCandidateSymbol).toUpperCase(),
    secType: String(c.secType ?? SecType.STK),
    exchange: c.exchange ?? 'SMART',
    primaryExchange: c.primaryExch ?? null,
    currency: c.currency ?? 'USD',
    localSymbol: c.localSymbol ?? null,
    conId: typeof c.conId === 'number' ? c.conId : null,
    resolvedAt: now,
    matchedCandidateSymbol,
  };
}

/** Queries IBKR for exactly one candidate contract shape. Resolves to the details list IBKR
 *  returns for that one `reqContractDetails` call - callers decide RESOLVED/AMBIGUOUS/NOT_FOUND. */
function queryContractDetailsOnce(
  ib: IBApi,
  reqId: number,
  contract: Contract,
  timeoutMs: number,
): Promise<ContractDetails[]> {
  return new Promise((resolve, reject) => {
    const results: ContractDetails[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ib.removeListener(EventName.contractDetails, onDetails);
        ib.removeListener(EventName.contractDetailsEnd, onEnd);
        ib.removeListener(EventName.error, onErr);
      } catch { /* ignore */ }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`IBKR reqContractDetails timeout for reqId=${reqId}`)));
    }, timeoutMs);
    const onDetails = (id: number, cd: ContractDetails) => {
      if (id !== reqId) return;
      results.push(cd);
    };
    const onEnd = (id: number) => {
      if (id !== reqId) return;
      finish(() => resolve(results));
    };
    const onErr = (err: Error, _code: number, id: number | undefined) => {
      if (id !== reqId) return;
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    };
    ib.on(EventName.contractDetails, onDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.on(EventName.error, onErr);
    try {
      ib.reqContractDetails(reqId, contract);
    } catch (e: any) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

/**
 * Resolves `symbol` to exactly one qualified IBKR contract, trying `buildCandidateContractSymbols`
 * in order and stopping at the first candidate that uniquely resolves. Fails closed
 * (AMBIGUOUS/NOT_FOUND/ERROR) rather than ever guessing among multiple real contracts - the
 * caller must never place an order or subscribe for a different security on a failed resolution.
 * Caches the outcome (including failures) so repeated calls for the same symbol do not repeatedly
 * hit IBKR - call `resetIbkrContractResolutionCacheForTests()` between tests.
 */
export async function resolveIbkrContract(
  ib: IBApi,
  symbol: string,
  allocateReqId: () => number,
  timeoutMs = 10_000,
): Promise<ContractResolutionOutcome> {
  const sym = symbol.toUpperCase();
  const cached = resolutionCache.get(sym);
  if (cached) return cached;

  const now = Date.now();
  try {
    for (const candidateSymbol of buildCandidateContractSymbols(sym)) {
      const reqId = allocateReqId();
      const contract: Contract = { symbol: candidateSymbol, secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
      const results = await queryContractDetailsOnce(ib, reqId, contract, timeoutMs);
      if (results.length === 1) {
        const outcome: ContractResolutionOutcome = { status: 'RESOLVED', contract: toResolvedContract(results[0], candidateSymbol, now) };
        resolutionCache.set(sym, outcome);
        return outcome;
      }
      if (results.length > 1) {
        // Ambiguous on the FIRST candidate that returns anything at all - do not silently keep
        // trying further candidates and do not guess among the real matches IBKR returned.
        const outcome: ContractResolutionOutcome = { status: 'AMBIGUOUS', symbol: sym, candidateCount: results.length, resolvedAt: now };
        resolutionCache.set(sym, outcome);
        return outcome;
      }
      // 0 results for this candidate - fall through and try the next one, if any.
    }
    const outcome: ContractResolutionOutcome = { status: 'NOT_FOUND', symbol: sym, resolvedAt: now };
    resolutionCache.set(sym, outcome);
    return outcome;
  } catch (e: any) {
    // Deliberately NOT cached - a transient IBKR/network error should be retried on the next
    // attempt, not permanently remembered as a resolution failure for this symbol.
    return { status: 'ERROR', symbol: sym, message: e instanceof Error ? e.message : String(e), resolvedAt: now };
  }
}
