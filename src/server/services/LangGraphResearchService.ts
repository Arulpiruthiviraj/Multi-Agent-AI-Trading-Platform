/**
 * ==========================================================
 * LangGraphResearchService.ts
 *
 * Thin HTTP client to the isolated LangGraph research companion (langgraph-research/, a separate
 * Python process - docs/architecture/ARGUS_ARCHITECTURE.md (LangGraph Research Service section)). Mirrors QuantCoreBridge.ts's
 * own fetch/timeout/health pattern exactly (same AbortSignal.timeout convention, same
 * connected/checkedAt health shape).
 *
 * Safety boundary (do not weaken):
 * - Off unless isLangGraphResearchEnabled() (config/langGraphResearch.json's master flag, default
 *   env var LANGGRAPH_RESEARCH_ENABLED, unset -> disabled).
 * - Never imports RiskEngine, OrderManagement, BrokerManager, ChiefTraderAgent, or the EventBus.
 *   This file must stay import-clean of all five - see langGraphArchitectureBoundary.test.ts,
 *   which greps this file (and langgraph-research/) for exactly that.
 * - Never throws to the caller. Every failure mode (disabled, unreachable, timeout, malformed
 *   response) returns a typed { ok: false, reason } result - the caller decides what "advisory
 *   unavailable" means for its own UI/CLI, this client never fabricates a substitute answer.
 * - Validates every field of a "successful" response before accepting it. A response missing a
 *   required field, using an out-of-enum value, or echoing back a different strategyId than what
 *   was requested is rejected as INVALID_RESPONSE, never silently coerced into something usable -
 *   the same anti-fabrication discipline as AIOutputValidator.ts, applied to a whole HTTP response
 *   instead of one AI provider's raw content.
 * ==========================================================
 */
import { isLangGraphResearchEnabled, langGraphResearch } from '../config/langGraphResearch';

export type StrategyGraduationRecommendation =
  | 'PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW'
  | 'NOT_YET_ELIGIBLE'
  | 'INSUFFICIENT_EVIDENCE';

/**
 * Deterministic, non-LLM strength bucket (Phase 3) - see langgraph-research/app/nodes.py's
 * _derive_evidence_strength(). Counts only Argus's own already-computed gate booleans; never
 * re-derives a gate and never influenced by the model's own `confidence` field below.
 */
export type EvidenceStrength = 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG';

export interface StrategyGraduationResult {
  lifecycleStatusAtRequest: string;
  live: 'GO' | 'NO-GO';
  failedGatesAtRequest: string[];
  recommendation: StrategyGraduationRecommendation;
  /** Model self-reported only (0-1). NOT a statistical confidence, NOT a validated win rate -
   *  see evidenceStrength for the deterministic counterpart. */
  confidence: number;
  rationale: string;
  limitations: string[];
  evidenceUsed: string[];
  /** Evidence arguing AGAINST advancing - explicitly prompted for (Phase 3). May be empty, but is
   *  never fabricated when empty (the model is instructed to say so rather than omit silently). */
  counterEvidence: string[];
  /** Deterministic absence-of-evidence flags derived from real StrategyEvidence fields - never an
   *  LLM guess at what might be missing. */
  missingEvidence: string[];
  evidenceStrength: EvidenceStrength;
  evidenceStrengthRationale: string;
  /** Deterministic - true unless recommendation is INSUFFICIENT_EVIDENCE. Never LLM-sourced. */
  humanReviewRequired: boolean;
  provenance: { source: string; strategyId: string; fetchedAt: string };
  modelGeneratedNarrative: string;
}

export interface LangGraphRunEnvelope {
  runId: string;
  correlationId: string;
  strategyId: string;
  graphVersion: string;
  status: 'COMPLETED' | 'FAILED';
  result: StrategyGraduationResult | null;
  error: string | null;
  durationMs: number;
  nodesExecuted: string[];
  providerModel: string | null;
}

export type LangGraphResearchOutcome =
  | { ok: true; envelope: LangGraphRunEnvelope }
  | { ok: false; reason: 'DISABLED' | 'UNAVAILABLE' | 'TIMEOUT' | 'INVALID_RESPONSE'; detail?: string };

const RECOMMENDATION_VALUES: StrategyGraduationRecommendation[] = [
  'PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW',
  'NOT_YET_ELIGIBLE',
  'INSUFFICIENT_EVIDENCE',
];

const EVIDENCE_STRENGTH_VALUES: EvidenceStrength[] = ['NONE', 'WEAK', 'MODERATE', 'STRONG'];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Rejects, rather than coerces, anything off-schema - including a strategyId mismatch, which
 * would otherwise let a stale or cross-request response be silently accepted as this request's
 * answer.
 */
function validateEnvelope(body: unknown, expectedStrategyId: string, expectedCorrelationId: string): LangGraphRunEnvelope | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!isNonEmptyString(b.runId) || !isNonEmptyString(b.correlationId) || !isNonEmptyString(b.strategyId) || !isNonEmptyString(b.graphVersion)) return null;
  if (b.correlationId !== expectedCorrelationId) return null;
  if (b.strategyId !== expectedStrategyId) return null;
  if (b.status !== 'COMPLETED' && b.status !== 'FAILED') return null;
  if (typeof b.durationMs !== 'number' || b.durationMs < 0) return null;
  if (!isStringArray(b.nodesExecuted)) return null;
  if (b.providerModel !== null && !isNonEmptyString(b.providerModel)) return null;

  if (b.status === 'FAILED') {
    if (!isNonEmptyString(b.error)) return null;
    return {
      runId: b.runId, correlationId: b.correlationId, strategyId: b.strategyId, graphVersion: b.graphVersion,
      status: 'FAILED', result: null, error: b.error, durationMs: b.durationMs,
      nodesExecuted: b.nodesExecuted, providerModel: (b.providerModel as string | null) ?? null,
    };
  }

  const r = b.result as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  if (!isNonEmptyString(r.lifecycleStatusAtRequest)) return null;
  if (r.live !== 'GO' && r.live !== 'NO-GO') return null;
  if (!isStringArray(r.failedGatesAtRequest)) return null;
  if (!RECOMMENDATION_VALUES.includes(r.recommendation as StrategyGraduationRecommendation)) return null;
  if (typeof r.confidence !== 'number' || !(r.confidence >= 0 && r.confidence <= 1)) return null;
  if (!isNonEmptyString(r.rationale)) return null;
  if (!isStringArray(r.limitations)) return null;
  if (!isStringArray(r.evidenceUsed)) return null;
  if (!isStringArray(r.counterEvidence)) return null;
  if (!isStringArray(r.missingEvidence)) return null;
  if (!EVIDENCE_STRENGTH_VALUES.includes(r.evidenceStrength as EvidenceStrength)) return null;
  if (!isNonEmptyString(r.evidenceStrengthRationale)) return null;
  if (typeof r.humanReviewRequired !== 'boolean') return null;
  // Legitimately empty (not missing) when the insufficient-evidence shortcut ran and no LLM was
  // ever called - real absence-of-narrative, not a fabrication risk, so this one field only
  // requires being a string, not a non-empty one.
  if (typeof r.modelGeneratedNarrative !== 'string') return null;
  const prov = r.provenance as Record<string, unknown> | undefined;
  if (!prov || !isNonEmptyString(prov.source) || prov.strategyId !== expectedStrategyId || !isNonEmptyString(prov.fetchedAt)) return null;

  return {
    runId: b.runId, correlationId: b.correlationId, strategyId: b.strategyId, graphVersion: b.graphVersion,
    status: 'COMPLETED',
    result: {
      lifecycleStatusAtRequest: r.lifecycleStatusAtRequest as string,
      live: r.live as 'GO' | 'NO-GO',
      failedGatesAtRequest: r.failedGatesAtRequest as string[],
      recommendation: r.recommendation as StrategyGraduationRecommendation,
      confidence: r.confidence as number,
      rationale: r.rationale as string,
      limitations: r.limitations as string[],
      evidenceUsed: r.evidenceUsed as string[],
      counterEvidence: r.counterEvidence as string[],
      missingEvidence: r.missingEvidence as string[],
      evidenceStrength: r.evidenceStrength as EvidenceStrength,
      evidenceStrengthRationale: r.evidenceStrengthRationale as string,
      humanReviewRequired: r.humanReviewRequired as boolean,
      provenance: prov as { source: string; strategyId: string; fetchedAt: string },
      modelGeneratedNarrative: r.modelGeneratedNarrative as string,
    },
    error: null,
    durationMs: b.durationMs,
    nodesExecuted: b.nodesExecuted,
    providerModel: (b.providerModel as string | null) ?? null,
  };
}

class LangGraphResearchServiceClient {
  private lastKnownHealth: { connected: boolean; checkedAt: string; detail?: string } = {
    connected: false,
    checkedAt: new Date(0).toISOString(),
    detail: 'not yet checked',
  };

  async health(): Promise<{ connected: boolean; checkedAt: string; detail?: string }> {
    if (!isLangGraphResearchEnabled()) {
      this.lastKnownHealth = { connected: false, checkedAt: new Date().toISOString(), detail: 'LANGGRAPH_RESEARCH_ENABLED is false' };
      return this.lastKnownHealth;
    }
    try {
      const res = await fetch(`${langGraphResearch.baseUrl}/health`, {
        signal: AbortSignal.timeout(langGraphResearch.healthCheckTimeoutMs),
      });
      this.lastKnownHealth = {
        connected: res.ok,
        checkedAt: new Date().toISOString(),
        detail: res.ok ? `HTTP ${res.status}` : `unhealthy: HTTP ${res.status}`,
      };
    } catch (e: any) {
      this.lastKnownHealth = { connected: false, checkedAt: new Date().toISOString(), detail: e?.message || 'unreachable' };
    }
    return this.lastKnownHealth;
  }

  cachedHealth(): { connected: boolean; checkedAt: string; detail?: string } {
    return this.lastKnownHealth;
  }

  /**
   * Requests exactly one strategy-graduation-recommendation run. Never throws - every failure
   * mode is a typed { ok: false, reason } result. `correlationId` is generated by the caller
   * (matching this codebase's traceId convention) so Node and Python logs can be joined.
   */
  async requestStrategyGraduationRecommendation(strategyId: string, correlationId: string): Promise<LangGraphResearchOutcome> {
    if (!isLangGraphResearchEnabled()) {
      return { ok: false, reason: 'DISABLED' };
    }
    let res: Response;
    try {
      res = await fetch(`${langGraphResearch.baseUrl}/v1/strategy-graduation-recommendation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyId, correlationId }),
        signal: AbortSignal.timeout(langGraphResearch.requestTimeoutMs),
      });
    } catch (e: any) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return { ok: false, reason: timedOut ? 'TIMEOUT' : 'UNAVAILABLE', detail: e?.message || 'unreachable' };
    }
    if (!res.ok) {
      return { ok: false, reason: 'UNAVAILABLE', detail: `HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: 'INVALID_RESPONSE', detail: 'response was not valid JSON' };
    }
    const envelope = validateEnvelope(body, strategyId, correlationId);
    if (!envelope) {
      return { ok: false, reason: 'INVALID_RESPONSE', detail: 'response failed schema validation' };
    }
    return { ok: true, envelope };
  }
}

export const langGraphResearchService = new LangGraphResearchServiceClient();
