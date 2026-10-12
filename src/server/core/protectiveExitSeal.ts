/**
 * Tamper-evident protective-exit provenance for the news_veto exemption
 * (2026-10-12, pre-market perfection mission, Phase 1 item 5).
 *
 * Problem: RiskEngine's news_veto gate is direction-blind and had no protective-exit
 * exemption - a high-impact news cluster within 4h would BLOCK a protective liquidation,
 * exactly during the volatility event the liquidation exists to escape. Provenance
 * (origin='PORTFOLIO_EXIT') is dropped before RiskEngine, so the engine cannot tell a
 * protective SELL from a discretionary one.
 *
 * Design (NOT a bare boolean flag - those are settable by any caller):
 *  1. `PortfolioMonitor.emitRiskExit` - the single verified protective path - mints a
 *     cryptographically random 128-bit seal bound to the exact (traceId, symbol, SELL)
 *     of the emitted exit idea and registers it in this module's canonical in-memory
 *     registry. The seal travels on the idea as `protectiveExitSeal`.
 *  2. `ChiefTraderAgent`'s genuine risk-exit auto-approve branch (isRiskExit: risk-exit
 *     agent name + PORTFOLIO_EXIT origin, the 2026-10-08 F3 dual-key check) is the ONLY
 *     place that propagates the seal onto CHIEF_APPROVED_IDEA. A seal attached to a
 *     discretionary-shaped idea is dropped at this boundary - it never reaches RiskEngine.
 *  3. `RiskAgent` forwards the seal to `RiskEngine.evaluateRisk()`.
 *  4. RiskEngine's news_veto gate calls `verifyAndConsumeProtectiveExitSeal()`, which
 *     returns true ONLY when: the seal is a registered, unexpired, unconsumed nonce;
 *     it was minted by the authorized minter; it is bound to this exact traceId,
 *     canonical symbol, and SELL side; and the proposal itself is a SELL.
 *     Verification CONSUMES the seal (single-use: no replay across ideas) and seals
 *     expire after `tradingSafety.protectiveExitSealTtlMs` (bounded registry, no leak).
 *
 * Anti-spoof properties: a forged seal string is not in the registry; a seal copied
 * from another idea fails the traceId/symbol/side binding; a bare `protectiveExit: true`
 * flag is never read (only `protectiveExitSeal` is); an expired or already-consumed seal
 * fails; a discretionary BUY/SELL never carries a verifiable seal because only the
 * verified protective path mints one. Every failure mode fails CLOSED: news_veto
 * applies exactly as before, no exemption.
 *
 * Threat-model note: this is in-process code, so "unspoofable" means unspoofable through
 * the idea/approval payloads and the event bus - the surfaces a discretionary idea path
 * (buggy or hostile emitter) can actually reach. Source-level impersonation of the minter
 * is outside the model (as with the existing agent-name + origin dual-key); the minter
 * allowlist below makes the single authorized call site explicit and grep-verifiable.
 *
 * Pure registry module: no DB, no network. Safe to import from RiskEngine, ChiefTrader,
 * PortfolioMonitor, and RiskAgent.
 */
import { randomUUID } from 'node:crypto';
import { tradingSafety } from '../config/tradingSafety';
import { validateInstrumentSymbol } from './InstrumentRegistry';

/** The single code path authorized to mint a protective-exit seal. */
export const PROTECTIVE_EXIT_AUTHORIZED_MINTER = 'PortfolioMonitor.emitRiskExit';

interface ProtectiveExitSealRecord {
  traceId: string;
  /** Canonical symbol (validateInstrumentSymbol), matching what gateTradeIdea stamps. */
  symbol: string;
  side: 'SELL';
  mintedAtMs: number;
  mintedBy: string;
}

const sealRegistry = new Map<string, ProtectiveExitSealRecord>();

function canonicalSymbol(symbol: unknown): string | null {
  if (typeof symbol !== 'string' || symbol.length === 0) return null;
  try {
    const validation = validateInstrumentSymbol(symbol);
    if (validation.valid && validation.canonicalSymbol) return validation.canonicalSymbol;
  } catch {
    // fall through to raw-symbol fallback below
  }
  return symbol;
}

function sealTtlMs(): number {
  const ttl = (tradingSafety as { protectiveExitSealTtlMs?: unknown }).protectiveExitSealTtlMs;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : NaN;
}

function purgeExpiredSeals(nowMs: number): void {
  const ttl = sealTtlMs();
  if (!Number.isFinite(ttl)) {
    // Misconfigured TTL: fail closed by treating every seal as expired (veto applies as
    // before). Purge the registry so nothing accumulates; warn once per process.
    if (sealRegistry.size > 0) {
      sealRegistry.clear();
      console.warn(
        '[protectiveExitSeal] tradingSafety.protectiveExitSealTtlMs is missing/invalid - ' +
        'protective-exit seals are disabled (news_veto applies to all ideas).',
      );
    }
    return;
  }
  for (const [seal, record] of sealRegistry) {
    if (nowMs - record.mintedAtMs > ttl) sealRegistry.delete(seal);
  }
}

/**
 * Mint a protective-exit seal for one exit idea. Called ONLY by
 * `PortfolioMonitor.emitRiskExit` - any other `mintedBy` throws. The seal binds the
 * idea's traceId + canonical symbol + SELL side at mint time.
 */
export function mintProtectiveExitSeal(args: {
  traceId: unknown;
  symbol: unknown;
  mintedBy: string;
}): string {
  if (args.mintedBy !== PROTECTIVE_EXIT_AUTHORIZED_MINTER) {
    throw new Error(
      `[protectiveExitSeal] unauthorized minter "${String(args.mintedBy)}" - only ` +
      `${PROTECTIVE_EXIT_AUTHORIZED_MINTER} may mint protective-exit seals.`,
    );
  }
  if (typeof args.traceId !== 'string' || args.traceId.length === 0) {
    throw new Error('[protectiveExitSeal] mint requires a non-empty traceId.');
  }
  const symbol = canonicalSymbol(args.symbol);
  if (symbol === null) {
    throw new Error('[protectiveExitSeal] mint requires a non-empty symbol.');
  }
  purgeExpiredSeals(Date.now());
  const seal = randomUUID();
  sealRegistry.set(seal, {
    traceId: args.traceId,
    symbol,
    side: 'SELL',
    mintedAtMs: Date.now(),
    mintedBy: args.mintedBy,
  });
  return seal;
}

/**
 * Verify a protective-exit seal against the registry and consume it (single-use).
 * Returns true only for a genuine, unexpired seal bound to this exact
 * (traceId, canonical symbol, SELL) proposal. Every other input - missing seal, forged
 * string, wrong traceId/symbol/side, expired, already consumed, unauthorized minter -
 * returns false WITHOUT consuming, so a failed spoof attempt can never burn a genuine
 * seal. Fail-closed: false means news_veto applies as before.
 */
export function verifyAndConsumeProtectiveExitSeal(
  seal: unknown,
  expected: { traceId: unknown; symbol: unknown; side: unknown },
): boolean {
  if (typeof seal !== 'string' || seal.length === 0) return false;
  if (expected.side !== 'SELL') return false;
  const expectedSymbol = canonicalSymbol(expected.symbol);
  if (expectedSymbol === null) return false;
  if (typeof expected.traceId !== 'string' || expected.traceId.length === 0) return false;

  purgeExpiredSeals(Date.now());
  const record = sealRegistry.get(seal);
  if (!record) return false;
  if (record.mintedBy !== PROTECTIVE_EXIT_AUTHORIZED_MINTER) return false;
  if (record.side !== 'SELL') return false;
  if (record.traceId !== expected.traceId) return false;
  if (record.symbol !== expectedSymbol) return false;

  // Genuine: single-use consume so the seal can never be replayed for another idea.
  sealRegistry.delete(seal);
  return true;
}

/** Test-only: drop all registered seals (isolates unit tests from each other). */
export function resetProtectiveExitSealsForTests(): void {
  sealRegistry.clear();
}

/** Test-only: current registry size (lets tests assert bounded growth, no leak). */
export function protectiveExitSealRegistrySizeForTests(): number {
  return sealRegistry.size;
}
