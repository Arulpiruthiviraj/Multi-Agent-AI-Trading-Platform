/**
 * ==========================================================
 * Module: strategiesEngine/core/createStrategy
 *
 * Purpose:
 * The one real factory for StrategyDefinition objects. Assigns the deterministic id (core/id.ts),
 * defaults version to 1, stamps metadata.createdAt once, and freezes the result so later code
 * cannot silently mutate a definition in place (Section 16 - versioning must go through
 * `bumpVersion`, never direct field assignment).
 * ==========================================================
 */
import { StrategyDefinition, StrategyMetadata } from './types';
import { computeStrategyId } from './id';
import { EvidenceState, DEFAULT_EVIDENCE_STATE } from './evidence';

export type CreateStrategyInput = Omit<StrategyDefinition, 'id' | 'version' | 'metadata' | 'evidenceState'> & {
  metadata: Omit<StrategyMetadata, 'createdAt'>;
  version?: number;
  /** Defaults to EXPERIMENTAL (Section 6's fail-closed default) - deliberately excluded from the
   *  identity hash (core/id.ts): a strategy's evidence maturing over time does not make it a
   *  different strategy, so this is never part of what computeStrategyId hashes. */
  evidenceState?: EvidenceState;
};

export function createStrategy(input: CreateStrategyInput): StrategyDefinition {
  const version = input.version ?? 1;
  const evidenceState = input.evidenceState ?? DEFAULT_EVIDENCE_STATE;
  const metadata: StrategyMetadata = { ...input.metadata, createdAt: new Date().toISOString() };
  const id = computeStrategyId({
    family: input.family,
    name: input.name,
    version,
    entryConditions: input.entryConditions,
    confirmationConditions: input.confirmationConditions,
    invalidationConditions: input.invalidationConditions,
    exitConditions: input.exitConditions,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    positionSizing: input.positionSizing,
    parameterValues: input.parameterValues,
  });

  const strategy: StrategyDefinition = { ...input, id, version, metadata, evidenceState };
  return Object.freeze(strategy);
}

/** Returns a NEW frozen StrategyDefinition with only evidenceState changed - id/version stay the
 *  SAME (evidence maturing is not a new strategy version, unlike bumpVersion's rule changes).
 *  Callers are expected to have already checked promoteEvidence()'s result and to persist a real
 *  schema.strategyEnginePromotions row alongside calling this - this function itself does not
 *  enforce the ladder (evidence.ts's promoteEvidence does) or write to the database. */
export function withEvidenceState(strategy: StrategyDefinition, evidenceState: EvidenceState): StrategyDefinition {
  return Object.freeze({ ...strategy, evidenceState });
}

/**
 * Returns a NEW StrategyDefinition with version+1 (and therefore a new id, since version is part
 * of the identity hash) and `changes` merged in. Never mutates `strategy` - Section 16: "A
 * modified strategy must receive a new version. Do not silently mutate an existing strategy
 * definition."
 */
export function bumpVersion(
  strategy: StrategyDefinition,
  changes: Partial<Omit<StrategyDefinition, 'id' | 'version' | 'metadata'>> = {},
  metadataChanges: Partial<Omit<StrategyMetadata, 'createdAt'>> = {},
): StrategyDefinition {
  return createStrategy({
    ...strategy,
    ...changes,
    version: strategy.version + 1,
    metadata: { ...strategy.metadata, ...metadataChanges, derivedFromId: strategy.id },
  });
}
