/**
 * Loads config/kronosDissimilarityGate.json - see that file's own $comment for the full rationale.
 * A reviewed config change, not a UI/API knob. Off unless the operator has explicitly set
 * KRONOS_OOD_GATE_ENABLED='true', same convention as config/researchTrigger.json's own master flag.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { isRuntimeFlagEnabled } from './effectiveRuntimeConfig';

export interface KronosDissimilarityGateConfig {
  enabledEnvVar: string;
  minReferenceSampleSize: number;
  maxReferenceSampleSize: number;
  oodZThreshold: number;
  referenceStatsCacheTtlMs: number;
}

function loadKronosDissimilarityGate(): KronosDissimilarityGateConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('kronosDissimilarityGate.json');

  if (typeof raw.enabledEnvVar !== 'string' || !raw.enabledEnvVar) {
    throw new Error('config/kronosDissimilarityGate.json missing string field: enabledEnvVar');
  }
  for (const key of ['minReferenceSampleSize', 'maxReferenceSampleSize', 'oodZThreshold', 'referenceStatsCacheTtlMs'] as const) {
    if (typeof raw[key] !== 'number' || !(raw[key] as number > 0)) {
      throw new Error(`config/kronosDissimilarityGate.json ${key} must be a positive number`);
    }
  }
  if ((raw.maxReferenceSampleSize as number) < (raw.minReferenceSampleSize as number)) {
    throw new Error('config/kronosDissimilarityGate.json maxReferenceSampleSize must be >= minReferenceSampleSize');
  }

  return {
    enabledEnvVar: raw.enabledEnvVar,
    minReferenceSampleSize: raw.minReferenceSampleSize as number,
    maxReferenceSampleSize: raw.maxReferenceSampleSize as number,
    oodZThreshold: raw.oodZThreshold as number,
    referenceStatsCacheTtlMs: raw.referenceStatsCacheTtlMs as number,
  };
}

export const kronosDissimilarityGate: KronosDissimilarityGateConfig = loadKronosDissimilarityGate();

/** Off unless the operator has explicitly set this env var to 'true'. */
export function isKronosDissimilarityGateEnabled(): boolean {
  return isRuntimeFlagEnabled(kronosDissimilarityGate.enabledEnvVar);
}
