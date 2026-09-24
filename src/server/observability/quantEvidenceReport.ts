/**
 * Milestone B.1 (2026-09-23): argus-cli quant-evidence - the per-producer observability view over
 * real `QUANT_EVIDENCE_PRODUCED` rows written by `quantEvidenceEmitter.ts`. Same pattern as
 * `tradingFunnelReport.ts` / `consensusPipelineReport.ts`: query already-persisted
 * `observability_events` rows for the window, parse their JSON payload, aggregate. Read-only. No
 * new data path, no write.
 */
import { db } from '../db';
import { observabilityEvents } from '../db/schema';
import { and, eq, gte } from 'drizzle-orm';

export interface QuantEvidenceProducerSummary {
  producer: string;
  count: number;
  latestTimestampIso: string;
  latestDirection: string;
  latestConfidence: number | null;
  latestMethodologyFamily: string;
  latestRegime: string | null;
  /** Fraction (0-1) of the tracked evidence fields that were REAL_VALUE or DERIVED (supported) in
   *  the LATEST row for this producer - not an average across the whole window, so it reflects
   *  what an operator would see right now, not a smeared historical blend. */
  supportedFieldFraction: number;
  unsupportedFieldFraction: number;
  latestCalibrationStatus: string;
  validationFailedCount: number;
}

export interface QuantEvidenceReport {
  windowSinceIso: string;
  totalProduced: number;
  totalValidationFailed: number;
  byProducer: QuantEvidenceProducerSummary[];
}

// Every ProvenancedField-shaped key on QuantEvidence (see quant/QuantEvidence.ts) - kept as a
// literal list here (not imported) because this module aggregates the already-serialized JSON
// payload, not a live QuantEvidence instance; a payload row IS the contract's own shape though, so
// this list must stay in sync with QuantEvidence.ts's field set.
const PROVENANCED_FIELD_KEYS = [
  'rawScore', 'normalizedScore', 'confidence', 'predictedReturn', 'predictedVolatility',
  'downsideRisk', 'upsidePotential', 'probabilityUp', 'probabilityDown', 'probabilityFlat',
  'uncertainty', 'calibrationSampleSize', 'regime', 'estimatedTransactionCostBps',
  'netExpectedReturn', 'dataFreshness', 'inputCompleteness',
] as const;

export async function buildQuantEvidenceReport(sinceIso: string): Promise<QuantEvidenceReport> {
  const sinceMs = new Date(sinceIso).getTime();

  const producedRows = await db.select().from(observabilityEvents).where(
    and(eq(observabilityEvents.eventType, 'QUANT_EVIDENCE_PRODUCED'), gte(observabilityEvents.ts, sinceMs)),
  );
  const failedRows = await db.select().from(observabilityEvents).where(
    and(eq(observabilityEvents.eventType, 'QUANT_EVIDENCE_VALIDATION_FAILED'), gte(observabilityEvents.ts, sinceMs)),
  );

  const parsedProduced = producedRows
    .map((r) => {
      try {
        const payload = JSON.parse(r.payload as string);
        return { ts: r.ts, payload };
      } catch {
        return null;
      }
    })
    .filter((p): p is { ts: number; payload: Record<string, any> } => p !== null);

  const validationFailedByProducer = new Map<string, number>();
  for (const r of failedRows) {
    try {
      const payload = JSON.parse(r.payload as string);
      const producer = typeof payload?.producer === 'string' ? payload.producer : 'UNKNOWN';
      validationFailedByProducer.set(producer, (validationFailedByProducer.get(producer) ?? 0) + 1);
    } catch {
      // suppressed row's own payload is malformed - still counted in totalValidationFailed below
    }
  }

  const byProducerRows = new Map<string, Array<{ ts: number; payload: Record<string, any> }>>();
  for (const row of parsedProduced) {
    const producer = typeof row.payload.producer === 'string' ? row.payload.producer : 'UNKNOWN';
    const list = byProducerRows.get(producer) ?? [];
    list.push(row);
    byProducerRows.set(producer, list);
  }

  const byProducer: QuantEvidenceProducerSummary[] = [];
  for (const [producer, rows] of byProducerRows.entries()) {
    rows.sort((a, b) => b.ts - a.ts);
    const latest = rows[0].payload;

    let supported = 0;
    let total = 0;
    for (const key of PROVENANCED_FIELD_KEYS) {
      const field = latest[key];
      if (field && typeof field === 'object' && 'provenance' in field) {
        total++;
        if (field.provenance === 'REAL_VALUE' || field.provenance === 'DERIVED') supported++;
      }
    }

    byProducer.push({
      producer,
      count: rows.length,
      latestTimestampIso: new Date(rows[0].ts).toISOString(),
      latestDirection: typeof latest.direction === 'string' ? latest.direction : 'UNKNOWN',
      latestConfidence: latest.confidence?.value ?? null,
      latestMethodologyFamily: typeof latest.methodologyFamily === 'string' ? latest.methodologyFamily : 'UNKNOWN',
      latestRegime: latest.regime?.value ?? null,
      supportedFieldFraction: total > 0 ? supported / total : 0,
      unsupportedFieldFraction: total > 0 ? (total - supported) / total : 0,
      latestCalibrationStatus: typeof latest.calibrationStatus === 'string' ? latest.calibrationStatus : 'UNKNOWN',
      validationFailedCount: validationFailedByProducer.get(producer) ?? 0,
    });
  }
  byProducer.sort((a, b) => b.count - a.count);

  const totalValidationFailed = failedRows.length;

  return {
    windowSinceIso: sinceIso,
    totalProduced: parsedProduced.length,
    totalValidationFailed,
    byProducer,
  };
}

export function formatQuantEvidenceReport(r: QuantEvidenceReport): string {
  const lines = [
    'ARGUS QUANT EVIDENCE (QuantEvidence contract observability, Milestone B.1)',
    '============================================================================',
    `Window since: ${r.windowSinceIso}`,
    `Total QUANT_EVIDENCE_PRODUCED:            ${r.totalProduced}`,
    `Total QUANT_EVIDENCE_VALIDATION_FAILED:   ${r.totalValidationFailed}`,
    '',
    'BY PRODUCER',
    '-----------',
  ];
  if (r.byProducer.length === 0) {
    lines.push('(no QUANT_EVIDENCE_PRODUCED rows in this window)');
  }
  for (const p of r.byProducer) {
    lines.push(
      `${p.producer}`,
      `  count:                    ${p.count}`,
      `  latest ts:                ${p.latestTimestampIso}`,
      `  latest direction:         ${p.latestDirection}`,
      `  latest confidence:        ${p.latestConfidence ?? 'null'}`,
      `  methodology family:       ${p.latestMethodologyFamily}`,
      `  latest regime:            ${p.latestRegime ?? 'null'}`,
      `  supported field fraction: ${(p.supportedFieldFraction * 100).toFixed(0)}% (REAL_VALUE/DERIVED)`,
      `  unsupported fraction:     ${(p.unsupportedFieldFraction * 100).toFixed(0)}% (NULL_NOT_SUPPORTED/NOT_YET_CALIBRATED)`,
      `  calibration status:       ${p.latestCalibrationStatus}`,
      `  validation failures:      ${p.validationFailedCount}`,
      '',
    );
  }
  return lines.join('\n');
}
