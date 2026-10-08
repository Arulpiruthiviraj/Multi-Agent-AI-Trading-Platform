/**
 * Loads config/aiCallGovernor.json - AICallGovernor (src/server/ai/AICallGovernor.ts), the
 * central gate for ALL optional AI calls. A reviewed config change, not a UI/API knob.
 *
 * Quant-first: enabling the governor does NOT initiate any AI call by itself. With
 * aiGovernorEnabled=false the gate is deny-all (every request returns SKIPPED/DISABLED);
 * with true, explicitly-requested optional AI goes through the governed check order
 * (budgets, cooldowns, circuit breaker, cache, singleflight). Validated quant trades
 * with zero AI either way.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface AiCallGovernorConfig {
  aiGovernorEnabled: boolean;
  jevEnabled: boolean;
  jevModel: string;
  jevTimeoutMs: number;
  jevMaxInFlight: number;
  jevQueueLimit: number;
  jevConsecutiveFailureThreshold: number;
  jevCircuitOpenCooldownMs: number;
  jevHalfOpenMaxProbes: number;
  aiGlobalOptionalCallsPerMinute: number;
  jevCallsPerMinute: number;
  generativeCallsPerMinute: number;
  aiPerSymbolCooldownMs: number;
  aiPerSymbolCallsPerMinute: number;
  /** Stale-entry backstop for AIRouter.routeTask()'s in-flight dedup map (D3). */
  aiRouterInflightDedupTtlMs: number;
  aiStateCacheMaxEntries: number;
  aiDecisionDeadlineMinLeadMs: number;
  cacheTtlMsByKind: Record<string, number>;
}

function reqBoolean(raw: Record<string, unknown>, field: string): boolean {
  if (typeof raw[field] !== 'boolean') {
    throw new Error(`config/aiCallGovernor.json field ${field} must be a boolean`);
  }
  return raw[field] as boolean;
}

function reqPositiveNumber(raw: Record<string, unknown>, field: string): number {
  const v = raw[field];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new Error(`config/aiCallGovernor.json field ${field} must be a positive finite number`);
  }
  return v;
}

function reqNonEmptyString(raw: Record<string, unknown>, field: string): string {
  const v = raw[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`config/aiCallGovernor.json field ${field} must be a non-empty string`);
  }
  return v;
}

function loadAiCallGovernor(): AiCallGovernorConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('aiCallGovernor.json');

  const cacheTtlRaw = raw.cacheTtlMsByKind;
  if (!cacheTtlRaw || typeof cacheTtlRaw !== 'object' || Array.isArray(cacheTtlRaw)) {
    throw new Error('config/aiCallGovernor.json field cacheTtlMsByKind must be an object');
  }
  const cacheTtlMsByKind: Record<string, number> = {};
  for (const [kind, ttl] of Object.entries(cacheTtlRaw as Record<string, unknown>)) {
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`config/aiCallGovernor.json cacheTtlMsByKind.${kind} must be a positive finite number`);
    }
    cacheTtlMsByKind[kind] = ttl;
  }

  return {
    aiGovernorEnabled: reqBoolean(raw, 'aiGovernorEnabled'),
    jevEnabled: reqBoolean(raw, 'jevEnabled'),
    jevModel: reqNonEmptyString(raw, 'jevModel'),
    jevTimeoutMs: reqPositiveNumber(raw, 'jevTimeoutMs'),
    jevMaxInFlight: reqPositiveNumber(raw, 'jevMaxInFlight'),
    jevQueueLimit: reqPositiveNumber(raw, 'jevQueueLimit'),
    jevConsecutiveFailureThreshold: reqPositiveNumber(raw, 'jevConsecutiveFailureThreshold'),
    jevCircuitOpenCooldownMs: reqPositiveNumber(raw, 'jevCircuitOpenCooldownMs'),
    jevHalfOpenMaxProbes: reqPositiveNumber(raw, 'jevHalfOpenMaxProbes'),
    aiGlobalOptionalCallsPerMinute: reqPositiveNumber(raw, 'aiGlobalOptionalCallsPerMinute'),
    jevCallsPerMinute: reqPositiveNumber(raw, 'jevCallsPerMinute'),
    generativeCallsPerMinute: reqPositiveNumber(raw, 'generativeCallsPerMinute'),
    aiPerSymbolCooldownMs: reqPositiveNumber(raw, 'aiPerSymbolCooldownMs'),
    aiPerSymbolCallsPerMinute: reqPositiveNumber(raw, 'aiPerSymbolCallsPerMinute'),
    aiRouterInflightDedupTtlMs: reqPositiveNumber(raw, 'aiRouterInflightDedupTtlMs'),
    aiStateCacheMaxEntries: reqPositiveNumber(raw, 'aiStateCacheMaxEntries'),
    aiDecisionDeadlineMinLeadMs: reqPositiveNumber(raw, 'aiDecisionDeadlineMinLeadMs'),
    cacheTtlMsByKind,
  };
}

export const aiCallGovernor: AiCallGovernorConfig = loadAiCallGovernor();

/** Runtime env override for the master switch (tests/ops). 'true'/'false'; unset -> config value. */
function envOverride(name: string): boolean | undefined {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** Master switch. false = deny-all: every request returns SKIPPED/DISABLED, zero AI calls. */
export function isAiCallGovernorEnabled(): boolean {
  return envOverride('ARGUS_AI_CALL_GOVERNOR_ENABLED') ?? aiCallGovernor.aiGovernorEnabled;
}

/** Capability switch for STRUCTURED_DECISION (Jev). false -> those requests SKIPPED/DISABLED. */
export function isJevCapabilityEnabled(): boolean {
  return envOverride('ARGUS_JEV_ENABLED') ?? aiCallGovernor.jevEnabled;
}
