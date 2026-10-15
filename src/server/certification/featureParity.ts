/**
 * CONFIGURATION_PARITY (2026-10-15). A feature can be implemented, unit-tested and credentialed yet receive zero events in production (Jev: JEV_API_KEY set, provider
 * and tests present, ARGUS_JEV_SHADOW_SCORING_ENABLED unset => every article returned at the first line). Certification used to report such a feature as
 * "configured: PASS". This classifier keeps the stages separate so "configured" can never read as "working":
 *   IMPLEMENTED -> ENABLED (effective release configuration) -> INVOKED (real events observed) -> PERSISTED (results written) -> VERIFIED (isolated end-to-end proof exists).
 * Pure; no I/O.
 */
export type FeatureParityStatus =
  | 'NOT_IMPLEMENTED'
  | 'DISABLED_BY_CONFIGURATION'
  | 'ENABLED_NOT_YET_OBSERVED'
  | 'INVOKED_NOT_PERSISTING'
  | 'ACTIVE'
  | 'ENABLED_BUT_BLOCKED';

export interface FeatureParityInput {
  implemented: boolean;
  /** Effective release configuration enables the feature end to end (flag + credentials + governor capability). */
  enabled: boolean;
  /** First blocking reason when not enabled (shown verbatim). */
  blockedReason?: string | null;
  /** What the release owner INTENDS: true = should be active in this release, false = deliberately off. */
  intendedActive: boolean;
  /** Real events that reached the feature, when observable (null = not observable in this context, e.g. pre-deployment certification). */
  eventsInvoked: number | null;
  /** Persisted outputs, when observable. */
  resultsPersisted: number | null;
}

export interface FeatureParityVerdict {
  status: FeatureParityStatus;
  /** PASS: state matches intent and is as proven as it can be here. FAIL: intent and effective configuration disagree or a stage is broken. NOT_PROVEN: cannot be known pre-deployment. */
  verdict: 'PASS' | 'FAIL' | 'NOT_PROVEN';
  reason: string;
}

export function classifyFeatureParity(i: FeatureParityInput): FeatureParityVerdict {
  if (!i.implemented) return { status: 'NOT_IMPLEMENTED', verdict: i.intendedActive ? 'FAIL' : 'PASS', reason: 'no implementation present' };
  if (!i.enabled) {
    const why = i.blockedReason ? `: ${i.blockedReason}` : '';
    return i.intendedActive
      ? { status: 'ENABLED_BUT_BLOCKED', verdict: 'FAIL', reason: `release intends this feature to be active but the effective configuration blocks it${why}` }
      : { status: 'DISABLED_BY_CONFIGURATION', verdict: 'PASS', reason: `deliberately off and reported as off, never as integrated${why}` };
  }
  if (!i.intendedActive) return { status: 'ACTIVE', verdict: 'FAIL', reason: 'feature is effectively enabled but the release intends it to be off' };
  if (i.eventsInvoked === null || i.resultsPersisted === null) {
    return { status: 'ENABLED_NOT_YET_OBSERVED', verdict: 'NOT_PROVEN', reason: 'enabled as intended; real invocation and persistence cannot be observed before deployment - requires an isolated end-to-end proof and post-deployment observation' };
  }
  if (i.eventsInvoked === 0) return { status: 'ENABLED_NOT_YET_OBSERVED', verdict: 'NOT_PROVEN', reason: 'enabled but zero eligible events observed so far - idle by design only if no eligible event occurred' };
  if (i.resultsPersisted === 0) return { status: 'INVOKED_NOT_PERSISTING', verdict: 'FAIL', reason: 'events invoked the feature but no result was persisted' };
  return { status: 'ACTIVE', verdict: 'PASS', reason: 'events received and results persisted' };
}
