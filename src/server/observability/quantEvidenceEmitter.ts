/**
 * ==========================================================
 * Module: observability/quantEvidenceEmitter
 *
 * Milestone B.1 (2026-09-23): wires the canonical QuantEvidence contract (quant/QuantEvidence.ts,
 * quant/quantEvidenceAdapters.ts - Milestone B) into runtime observability ONLY. This is a
 * write-only leaf: it emits a real `QUANT_EVIDENCE_PRODUCED` (or, on validation failure,
 * `QUANT_EVIDENCE_VALIDATION_FAILED`) row into `observability_events` via the existing
 * `structuredLogger` pipeline - the SAME pipeline `JavaQuantAdvisoryService.ts` already uses for
 * `QUANT_ADVISORY_PAYLOAD_STREAMED`. Nothing downstream (ChiefTrader, RiskEngine, PositionSizing,
 * OMS, BrokerManager, ReflectionEngine, ModelPerformanceTracker/`recordPrediction`) reads this
 * event type. It is called AFTER a vote service's own decision is made, never before, and never
 * changes that decision.
 *
 * Fail-open by construction: `structuredLogger.*` (see StructuredLogger.ts) already never throws
 * to its caller. `emitQuantEvidenceObservability` adds nothing above that except its own
 * defensive validation, and callers additionally wrap the call site in `observeSafe` as a second,
 * belt-and-suspenders layer - see JavaCoreEnsembleVoteService.ts / JavaQuantAdvisoryService.ts.
 * ==========================================================
 */
import { structuredLogger } from './StructuredLogger';
import { EVENTS } from '../core/eventNames';
import type { QuantEvidence, FieldProvenance, ProvenancedField } from '../quant/QuantEvidence';

const VALID_PROVENANCE: ReadonlySet<FieldProvenance> = new Set<FieldProvenance>([
  'REAL_VALUE',
  'DERIVED',
  'NULL_NOT_SUPPORTED',
  'NOT_YET_CALIBRATED',
]);

const VALID_DIRECTIONS = new Set(['BUY', 'SELL', 'HOLD', 'DATA_UNAVAILABLE']);

function isPlainProvenancedField(field: unknown): field is ProvenancedField<unknown> {
  return !!field && typeof field === 'object' && 'provenance' in (field as object) && 'value' in (field as object);
}

/** A numeric ProvenancedField is valid iff its label is one of the 4 allowed strings AND (its
 *  value is null, OR its value is a finite number - never NaN/Infinity). */
function isValidNumericField(field: unknown): field is ProvenancedField<number> {
  if (!isPlainProvenancedField(field)) return false;
  if (!VALID_PROVENANCE.has(field.provenance)) return false;
  const v = field.value;
  if (v === null) return true;
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidStringField(field: unknown): field is ProvenancedField<string> {
  if (!isPlainProvenancedField(field)) return false;
  if (!VALID_PROVENANCE.has(field.provenance)) return false;
  const v = field.value;
  return v === null || typeof v === 'string';
}

export interface QuantEvidenceValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Real, defensive validation before any emission (item 4 of the Milestone B.1 mandate). On any
 * failure the caller must suppress the event - never sanitize by fabricating a replacement value.
 */
export function validateQuantEvidenceForEmission(evidence: QuantEvidence): QuantEvidenceValidationResult {
  if (!evidence || typeof evidence !== 'object') return { valid: false, reason: 'not_an_object' };
  if (typeof evidence.producer !== 'string' || evidence.producer.length === 0) {
    return { valid: false, reason: 'missing_producer' };
  }
  if (!VALID_DIRECTIONS.has(evidence.direction)) return { valid: false, reason: 'invalid_direction' };

  const numericFields: Array<[string, unknown]> = [
    ['rawScore', evidence.rawScore],
    ['normalizedScore', evidence.normalizedScore],
    ['confidence', evidence.confidence],
    ['predictedReturn', evidence.predictedReturn],
    ['predictedVolatility', evidence.predictedVolatility],
    ['downsideRisk', evidence.downsideRisk],
    ['upsidePotential', evidence.upsidePotential],
    ['probabilityUp', evidence.probabilityUp],
    ['probabilityDown', evidence.probabilityDown],
    ['probabilityFlat', evidence.probabilityFlat],
    ['uncertainty', evidence.uncertainty],
    ['calibrationSampleSize', evidence.calibrationSampleSize],
    ['estimatedTransactionCostBps', evidence.estimatedTransactionCostBps],
    ['netExpectedReturn', evidence.netExpectedReturn],
    ['dataFreshness', evidence.dataFreshness],
    ['inputCompleteness', evidence.inputCompleteness],
  ];
  for (const [name, field] of numericFields) {
    if (!isValidNumericField(field)) return { valid: false, reason: `invalid_numeric_field:${name}` };
  }
  if (!isValidStringField(evidence.regime)) return { valid: false, reason: 'invalid_field:regime' };

  const confidence = (evidence.confidence as ProvenancedField<number>).value;
  if (confidence !== null && (confidence < 0 || confidence > 1)) {
    return { valid: false, reason: 'confidence_out_of_range' };
  }

  const pUp = (evidence.probabilityUp as ProvenancedField<number>).value;
  const pDown = (evidence.probabilityDown as ProvenancedField<number>).value;
  const pFlat = (evidence.probabilityFlat as ProvenancedField<number>).value;
  if (pUp !== null || pDown !== null || pFlat !== null) {
    for (const [name, p] of [['probabilityUp', pUp], ['probabilityDown', pDown], ['probabilityFlat', pFlat]] as const) {
      if (p !== null && (p < 0 || p > 1)) return { valid: false, reason: `probability_out_of_range:${name}` };
    }
    if (pUp !== null && pDown !== null && pFlat !== null) {
      const sum = pUp + pDown + pFlat;
      if (sum < 0.9 || sum > 1.1) return { valid: false, reason: 'probability_sum_invalid' };
    }
  }

  if (typeof evidence.provenance !== 'string') return { valid: false, reason: 'invalid_field:provenance_summary' };

  return { valid: true };
}

/**
 * Emit `QUANT_EVIDENCE_PRODUCED` (or a suppression `QUANT_EVIDENCE_VALIDATION_FAILED` WARN) via
 * the existing structuredLogger/observability_events pipeline. `symbol` is passed separately (not
 * a QuantEvidence field) so it lands in the indexed `observability_events.symbol` column, matching
 * every other symbol-scoped structured log call in this codebase.
 *
 * Never throws. Never affects a vote decision - this must always be called strictly after the
 * vote service has already decided what to do.
 */
export function emitQuantEvidenceObservability(symbol: string, evidence: QuantEvidence): void {
  const validation = validateQuantEvidenceForEmission(evidence);
  if (!validation.valid) {
    structuredLogger.warn('quant_evidence_validation_failed - event suppressed', {
      category: 'AGENT',
      eventType: EVENTS.QUANT_EVIDENCE_VALIDATION_FAILED,
      symbol,
      producer: (evidence && typeof evidence === 'object' && typeof evidence.producer === 'string') ? evidence.producer : 'UNKNOWN',
      reason: validation.reason,
    });
    return;
  }
  structuredLogger.info('quant_evidence_produced', {
    category: 'AGENT',
    eventType: EVENTS.QUANT_EVIDENCE_PRODUCED,
    symbol,
    ...evidence,
  });
}
