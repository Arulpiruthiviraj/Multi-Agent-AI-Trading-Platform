/**
 * Structured Bull/Bear research records. Numeric market facts are not accepted from the LLM.
 * Not consumed by ChiefTrader unless QUANT_BULL_BEAR_ENABLED=true (see bullBearResearch.json).
 */
import { coerceEnum, coerceString, coerceStringArray, normalizeConfidence01 } from '../AIOutputValidator';
import { bullBearResearchConfig, isBullBearResearchEnabled } from '../../config/bullBearResearch';

export interface StructuredResearchNote {
  schemaVersion: number;
  stance: 'BULL' | 'BEAR';
  thesisSummary: string;
  supportingFactors: string[];
  contradictingFactors: string[];
  missingEvidence: string[];
  riskFactors: string[];
  invalidationCondition: string;
  expectedCatalyst: string;
  timeHorizon: string;
  /** Always null here — filled only from Quant engines by the caller. */
  entry: null;
  stop: null;
  target: null;
  expectedValue: null;
  probability: null;
  /** Interpretive only, 0-1, not a calibrated probability. */
  confidence: number;
  inventedNumericFieldsRejected: string[];
}

const NUMERIC_FORBIDDEN = () => [...bullBearResearchConfig.numericFieldsMustComeFromQuant];

export function parseResearchNote(raw: unknown, stance: 'BULL' | 'BEAR'): StructuredResearchNote {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const rejected = NUMERIC_FORBIDDEN().filter(k => obj[k] !== undefined && obj[k] !== null);
  return {
    schemaVersion: bullBearResearchConfig.schemaVersion,
    stance: coerceEnum(obj.stance, ['BULL', 'BEAR'] as const, stance),
    thesisSummary: coerceString(obj.thesisSummary, ''),
    supportingFactors: coerceStringArray(obj.supportingFactors),
    contradictingFactors: coerceStringArray(obj.contradictingFactors),
    missingEvidence: coerceStringArray(obj.missingEvidence),
    riskFactors: coerceStringArray(obj.riskFactors),
    invalidationCondition: coerceString(obj.invalidationCondition, ''),
    expectedCatalyst: coerceString(obj.expectedCatalyst, ''),
    timeHorizon: coerceString(obj.timeHorizon, ''),
    entry: null,
    stop: null,
    target: null,
    expectedValue: null,
    probability: null,
    confidence: normalizeConfidence01(obj.confidence, 0),
    inventedNumericFieldsRejected: rejected,
  };
}

export { isBullBearResearchEnabled, bullBearResearchConfig };
