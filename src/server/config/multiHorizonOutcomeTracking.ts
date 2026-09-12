/**
 * Loads config/multiHorizonOutcomeTracking.json - see that file's own $comment for the full
 * rationale (Research Memory Platform Phase 2, multi-horizon forward-outcome tracking).
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface MultiHorizonDefinition {
  label: string;
  bars: number;
}

export interface MultiHorizonOutcomeTrackingConfig {
  horizons: MultiHorizonDefinition[];
  evaluationIntervalMs: number;
}

function loadMultiHorizonOutcomeTracking(): MultiHorizonOutcomeTrackingConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('multiHorizonOutcomeTracking.json');

  const horizonsRaw = raw.horizons;
  if (!Array.isArray(horizonsRaw) || horizonsRaw.length === 0) {
    throw new Error('config/multiHorizonOutcomeTracking.json missing non-empty array field: horizons');
  }
  const horizons: MultiHorizonDefinition[] = [];
  const seenLabels = new Set<string>();
  for (const item of horizonsRaw) {
    if (!item || typeof item !== 'object') {
      throw new Error('config/multiHorizonOutcomeTracking.json horizons[] entry is not an object');
    }
    const row = item as Record<string, unknown>;
    if (typeof row.label !== 'string' || !row.label) {
      throw new Error('config/multiHorizonOutcomeTracking.json horizon entry missing label');
    }
    if (seenLabels.has(row.label)) {
      throw new Error(`config/multiHorizonOutcomeTracking.json duplicate horizon label: ${row.label}`);
    }
    seenLabels.add(row.label);
    if (typeof row.bars !== 'number' || !(row.bars > 0) || !Number.isInteger(row.bars)) {
      throw new Error(`config/multiHorizonOutcomeTracking.json horizon "${row.label}" must have a positive integer bars field`);
    }
    horizons.push({ label: row.label, bars: row.bars });
  }
  horizons.sort((a, b) => a.bars - b.bars);

  const evaluationIntervalMs = raw.evaluationIntervalMs;
  if (typeof evaluationIntervalMs !== 'number' || !(evaluationIntervalMs > 0)) {
    throw new Error('config/multiHorizonOutcomeTracking.json missing positive-number field: evaluationIntervalMs');
  }

  return { horizons, evaluationIntervalMs };
}

export const multiHorizonOutcomeTracking: MultiHorizonOutcomeTrackingConfig = loadMultiHorizonOutcomeTracking();
