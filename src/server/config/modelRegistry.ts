/**
 * Real validating loader + graduation-ladder rules for config/engineOwnership.json (the
 * institutional activation plan's "ModelRegistry" concept). Formalizes the promotion ladder the
 * user specified:
 *
 *   RESEARCH -> BACKTEST -> WALK_FORWARD -> SHADOW -> PAPER -> VALIDATED -> PRODUCTION_CANDIDATE
 *
 * plus two terminal states (DEPRECATED, DISABLED) reachable from any non-terminal rung. No model
 * has ever reached PRODUCTION_CANDIDATE in this codebase - promoting a model is a reviewed change
 * to config/engineOwnership.json (same convention every other config/*.json file in this repo
 * already uses: numbers/status are a reviewed file, not a live-mutable runtime toggle), matching
 * the user's own "controlled promotion of models into production" principle - no silent or
 * automatic self-promotion path exists anywhere in this module.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export const MODEL_LIFECYCLE_LADDER = [
  'RESEARCH',
  'BACKTEST',
  'WALK_FORWARD',
  'SHADOW',
  'PAPER',
  'VALIDATED',
  'PRODUCTION_CANDIDATE',
] as const;

export type ModelLifecycleRung = typeof MODEL_LIFECYCLE_LADDER[number];
export type ModelLifecycleStatus = ModelLifecycleRung | 'DEPRECATED' | 'DISABLED';

const ALL_STATUSES: ReadonlySet<string> = new Set<string>([...MODEL_LIFECYCLE_LADDER, 'DEPRECATED', 'DISABLED']);

export interface ModelRegistryEntry {
  owner: string;
  status?: ModelLifecycleStatus;
  javaAvailable?: boolean;
  javaLocation?: string;
  nodeLocation?: string;
  httpEndpoint?: string;
  liveConsumer?: string;
  javaAuthoritative?: boolean;
  migrationStatus?: string;
  notes?: string;
  [key: string]: unknown;
}

export type RegistrySection = 'indicators' | 'strategies' | 'quantModels' | 'riskAndExecution' | 'backtesting';

export interface EngineOwnershipRegistry {
  $comment?: string;
  indicators: Record<string, ModelRegistryEntry>;
  strategies: Record<string, ModelRegistryEntry>;
  quantModels: Record<string, ModelRegistryEntry>;
  riskAndExecution: Record<string, ModelRegistryEntry>;
  backtesting: Record<string, ModelRegistryEntry>;
}

const SECTIONS: RegistrySection[] = ['indicators', 'strategies', 'quantModels', 'riskAndExecution', 'backtesting'];

function validateEntry(section: string, modelId: string, entry: unknown): void {
  if (modelId.startsWith('$')) return; // $comment-style keys
  if (!entry || typeof entry !== 'object') {
    throw new Error(`config/engineOwnership.json: ${section}.${modelId} is not an object`);
  }
  const status = (entry as ModelRegistryEntry).status;
  if (status !== undefined && !ALL_STATUSES.has(status)) {
    throw new Error(`config/engineOwnership.json: ${section}.${modelId} has invalid status "${status}" - must be one of ${[...ALL_STATUSES].join(', ')}`);
  }
}

let cached: EngineOwnershipRegistry | null = null;

export function loadEngineOwnershipRegistry(): EngineOwnershipRegistry {
  if (cached) return cached;
  const raw = loadRepoConfigJson<EngineOwnershipRegistry>('engineOwnership.json');
  for (const section of SECTIONS) {
    const group = raw[section] || {};
    for (const [modelId, entry] of Object.entries(group)) {
      validateEntry(section, modelId, entry);
    }
  }
  cached = raw;
  return raw;
}

export function getModelEntry(section: RegistrySection, modelId: string): ModelRegistryEntry | null {
  const registry = loadEngineOwnershipRegistry();
  return registry[section]?.[modelId] ?? null;
}

export function getModelStatus(section: RegistrySection, modelId: string): ModelLifecycleStatus | null {
  return getModelEntry(section, modelId)?.status ?? null;
}

/**
 * Real, pure graduation-ladder validator. Forward path is strictly one rung at a time (no
 * skipping BACKTEST straight to SHADOW, for example) - a real promotion earns each step's
 * evidence. DEPRECATED/DISABLED are reachable from any non-terminal rung (retiring or disabling a
 * model doesn't require walking the ladder back down first). Neither terminal state can promote
 * to anything else.
 */
export function isValidPromotion(from: ModelLifecycleStatus, to: ModelLifecycleStatus): boolean {
  if (from === 'DEPRECATED' || from === 'DISABLED') return false;
  if (to === 'DEPRECATED' || to === 'DISABLED') return true;
  const fromIdx = MODEL_LIFECYCLE_LADDER.indexOf(from as ModelLifecycleRung);
  const toIdx = MODEL_LIFECYCLE_LADDER.indexOf(to as ModelLifecycleRung);
  if (fromIdx === -1 || toIdx === -1) return false;
  return toIdx === fromIdx + 1;
}

/** True only for the two rungs where a model may actually influence anything beyond pure observation - still never a vote on its own; see the institutional activation plan's calculation-vs-authorization boundary. */
export function isEligibleForLiveConsideration(status: ModelLifecycleStatus): boolean {
  return status === 'VALIDATED' || status === 'PRODUCTION_CANDIDATE';
}

/** Test-only: clears the module-level cache so a test can reload engineOwnership.json after mocking loadRepoConfigJson. */
export function resetEngineOwnershipRegistryCacheForTests(): void {
  cached = null;
}
