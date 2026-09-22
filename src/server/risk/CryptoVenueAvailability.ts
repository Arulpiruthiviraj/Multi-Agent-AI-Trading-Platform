/**
 * Crypto Expansion Phase 3 (2026-09-21), completed Phase 13 (2026-09-22). RiskEngine gate 12
 * (market_hours) equity-only concept (Alpaca clock open/closed) does not apply to a 24/7 asset -
 * crypto venues don't "close." What genuinely gates a crypto proposal instead is real
 * infrastructure readiness: is this instrument registered and enabled for paper trading, is there
 * a real (non-stale) price observation for it, and does a paper-capable broker for it actually
 * exist. This module answers those three questions from real signals only - it never silently
 * passes because infrastructure is missing.
 *
 * PAPER_BROKER_AVAILABLE now checks BrokerManager.getCryptoBrokerId() for real - true only when an
 * operator has explicitly set ARGUS_CRYPTO_ACTIVE_BROKER to a registered, crypto-capable broker
 * (CryptoPaperBroker.ts, PAPER only). Unconfigured (the default) still correctly reports
 * unavailable - this was never a hardcoded stub "to make tests pass," it was the true state before
 * Phase 13 existed, and remains the true state for any deployment that hasn't opted in.
 */
import type { CryptoInstrumentDefinition } from '../config/cryptoInstruments';
import { BrokerManager } from '../../brokers/BrokerManager';

export type CryptoVenueAvailabilityReasonCode =
  | 'OK'
  | 'INSTRUMENT_NOT_ENABLED'
  | 'DATA_SOURCE_UNAVAILABLE'
  | 'DATA_STALE'
  | 'PAPER_BROKER_UNAVAILABLE';

export interface CryptoVenueAvailabilityResult {
  passed: boolean;
  reasonCode: CryptoVenueAvailabilityReasonCode;
  detail: {
    instrumentEnabled: boolean;
    dataSourceAvailable: boolean;
    priceAgeMs: number | null;
    staleThresholdMs: number;
    paperBrokerAvailable: boolean;
  };
}

/**
 * Real check against BrokerManager's crypto-broker routing (Phase 13) - true only when an operator
 * has explicitly configured ARGUS_CRYPTO_ACTIVE_BROKER to a registered, crypto-capable broker.
 * Isolated in its own function (not inlined at the call site) so there is exactly one place this
 * logic lives, matching the file's own pre-Phase-13 convention.
 */
export function isCryptoPaperBrokerAvailable(): boolean {
  return BrokerManager.getInstance().getCryptoBrokerId() !== null;
}

export function evaluateCryptoVenueAvailability(opts: {
  instrument: CryptoInstrumentDefinition | null;
  priceAgeMs: number | null;
  staleThresholdMs: number;
}): CryptoVenueAvailabilityResult {
  const instrumentEnabled = !!opts.instrument?.enabledForPaper;
  const dataSourceAvailable = opts.priceAgeMs !== null;
  const dataFresh = dataSourceAvailable && (opts.priceAgeMs as number) <= opts.staleThresholdMs;
  const paperBrokerAvailable = isCryptoPaperBrokerAvailable();

  const detail = {
    instrumentEnabled,
    dataSourceAvailable,
    priceAgeMs: opts.priceAgeMs,
    staleThresholdMs: opts.staleThresholdMs,
    paperBrokerAvailable,
  };

  if (!instrumentEnabled) return { passed: false, reasonCode: 'INSTRUMENT_NOT_ENABLED', detail };
  if (!dataSourceAvailable) return { passed: false, reasonCode: 'DATA_SOURCE_UNAVAILABLE', detail };
  if (!dataFresh) return { passed: false, reasonCode: 'DATA_STALE', detail };
  if (!paperBrokerAvailable) return { passed: false, reasonCode: 'PAPER_BROKER_UNAVAILABLE', detail };
  return { passed: true, reasonCode: 'OK', detail };
}
