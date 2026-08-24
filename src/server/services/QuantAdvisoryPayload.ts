/**
 * The QuantAdvisoryPayload contract - what JavaQuantAdvisoryService.ts streams to the rest of
 * Argus once the Java Dynamic Regime & Volatility Multiplier Layer (RegimeVolatilityOverlay.java,
 * via QuantCoreBridge.fetchInstitutionalAdvisory) produces a result. executionEnvironment is
 * hardcoded to the literal 'ADVISORY_ONLY' - not a config value, not something a caller can
 * override - because this payload must never be mistaken for a TRADE_IDEA_GENERATED event or any
 * other input ChiefTraderAgent/EvidenceAggregator consumes. It is emitted via a distinct event
 * type (EVENTS.QUANT_ADVISORY_PAYLOAD_STREAMED) that nothing in the live decision spine
 * subscribes to.
 */
import type { InstitutionalAdvisoryResult, EnsembleSide, HmmRegimeLabel } from './QuantCoreBridge';

export interface QuantAdvisoryPayload {
  schemaVersion: 1;
  executionEnvironment: 'ADVISORY_ONLY';
  symbol: string;
  timestamp: string;
  rawSide: EnsembleSide;
  rawAvgConfidence: number;
  rawEffectiveIndependentCount: number;
  regime: HmmRegimeLabel;
  regimeMultiplier: number;
  currentVolatility: number;
  volatilityMultiplier: number;
  adjustedConfidence: number;
  gated: boolean;
  reasoning: string;
  agreeingModelIds: string[];
  dissentingModelIds: string[];
}

/** Pure serializer - the Java response plus the local symbol/timestamp context is all this needs. */
export function buildQuantAdvisoryPayload(symbol: string, advisory: InstitutionalAdvisoryResult, timestamp: string = new Date().toISOString()): QuantAdvisoryPayload {
  return {
    schemaVersion: 1,
    executionEnvironment: 'ADVISORY_ONLY',
    symbol,
    timestamp,
    rawSide: advisory.rawSide,
    rawAvgConfidence: advisory.rawAvgConfidence,
    rawEffectiveIndependentCount: advisory.rawEffectiveIndependentCount,
    regime: advisory.regime,
    regimeMultiplier: advisory.regimeMultiplier,
    currentVolatility: advisory.currentVolatility,
    volatilityMultiplier: advisory.volatilityMultiplier,
    adjustedConfidence: advisory.adjustedConfidence,
    gated: advisory.gated,
    reasoning: advisory.reasoning,
    agreeingModelIds: advisory.agreeingModelIds,
    dissentingModelIds: advisory.dissentingModelIds,
  };
}
