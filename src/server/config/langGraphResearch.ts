/**
 * Loads config/langGraphResearch.json - the isolated LangGraph research service
 * (docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md). A reviewed config change, not a UI/API knob.
 * Same off-unless-explicit convention as config/aiCostGovernor.json's master flag.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { isRuntimeFlagEnabled } from './effectiveRuntimeConfig';

export interface LangGraphResearchConfig {
  langGraphResearchEnabledEnvVar: string;
  baseUrl: string;
  port: number;
  requestTimeoutMs: number;
  healthCheckTimeoutMs: number;
  maxConcurrentRuns: number;
  /** Phase 3: a persisted recommendation's evidence is flagged stale, at read time, once its
   *  provenance.fetchedAt is older than this. See config/langGraphResearch.json's own comment. */
  researchRecommendationStalenessMs: number;
}

function loadLangGraphResearch(): LangGraphResearchConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('langGraphResearch.json');

  if (typeof raw.langGraphResearchEnabledEnvVar !== 'string' || !raw.langGraphResearchEnabledEnvVar) {
    throw new Error('config/langGraphResearch.json missing string field: langGraphResearchEnabledEnvVar');
  }
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.startsWith('http://127.0.0.1')) {
    throw new Error('config/langGraphResearch.json baseUrl must be an http://127.0.0.1 loopback URL');
  }
  if (typeof raw.port !== 'number' || !(raw.port > 0)) {
    throw new Error('config/langGraphResearch.json port must be a positive number');
  }
  if (typeof raw.requestTimeoutMs !== 'number' || !(raw.requestTimeoutMs > 0)) {
    throw new Error('config/langGraphResearch.json requestTimeoutMs must be a positive number');
  }
  if (typeof raw.healthCheckTimeoutMs !== 'number' || !(raw.healthCheckTimeoutMs > 0)) {
    throw new Error('config/langGraphResearch.json healthCheckTimeoutMs must be a positive number');
  }
  if (typeof raw.maxConcurrentRuns !== 'number' || !(raw.maxConcurrentRuns > 0)) {
    throw new Error('config/langGraphResearch.json maxConcurrentRuns must be a positive number');
  }
  if (typeof raw.researchRecommendationStalenessMs !== 'number' || !(raw.researchRecommendationStalenessMs > 0)) {
    throw new Error('config/langGraphResearch.json researchRecommendationStalenessMs must be a positive number');
  }

  return {
    langGraphResearchEnabledEnvVar: raw.langGraphResearchEnabledEnvVar,
    baseUrl: raw.baseUrl,
    port: raw.port,
    requestTimeoutMs: raw.requestTimeoutMs,
    healthCheckTimeoutMs: raw.healthCheckTimeoutMs,
    maxConcurrentRuns: raw.maxConcurrentRuns,
    researchRecommendationStalenessMs: raw.researchRecommendationStalenessMs,
  };
}

export const langGraphResearch: LangGraphResearchConfig = loadLangGraphResearch();

/** Off unless the operator has explicitly set this env var to 'true'. Master switch - matches
 *  config/aiCostGovernor.json's isAiCostGovernorEnabled() convention exactly. */
export function isLangGraphResearchEnabled(): boolean {
  return isRuntimeFlagEnabled(langGraphResearch.langGraphResearchEnabledEnvVar);
}
