/**
 * Loads config/aiModels.json - per-agent local Ollama model specialization. A reviewed config
 * change, not a UI/API knob. Every route key is a real AIRouter.routeTask() agentType string
 * (verified by grep before the JSON was written) - see that file's own header for which two real
 * domains (TechnicalAgent, ChiefTraderAgent consensus) are deliberately absent and why.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface AiModelRoute {
  model: string;
  temperature: number;
  timeoutMs: number;
  fallback: string[];
  rationale: string;
}

export interface AiModelsConfig {
  ollama: { baseUrl: string; keepAlive: string; enabled: boolean };
  /** Outer bound for Bull/Bear research + ConsensusDebate — fail-closed HOLD when exceeded. */
  researchTimeoutMs: number;
  /** Output-token cap sent on every provider call (max_tokens / maxOutputTokens). Controls cost and
   *  keeps a low-balance account from implicitly requesting a model's full max output. */
  maxResponseTokens: number;
  heavyModels: string[];
  concurrency: { maxConcurrentHeavyModels: number; maxQueueDepth: number };
  routes: Record<string, AiModelRoute>;
}

/** Agent types whose routeTask calls use researchTimeoutMs (leave heavy-mutex contention). */
export const RESEARCH_AGENT_TYPES = new Set(['BullResearcher', 'BearResearcher']);

function loadAiModels(): AiModelsConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('aiModels.json');

  const ollama = raw.ollama as any;
  if (!ollama || typeof ollama.baseUrl !== 'string' || typeof ollama.keepAlive !== 'string' || typeof ollama.enabled !== 'boolean') {
    throw new Error('config/aiModels.json missing/invalid ollama block');
  }
  if (typeof raw.researchTimeoutMs !== 'number' || !(raw.researchTimeoutMs > 0)) {
    throw new Error('config/aiModels.json researchTimeoutMs must be a positive number');
  }
  if (typeof raw.maxResponseTokens !== 'number' || !(raw.maxResponseTokens > 0)) {
    throw new Error('config/aiModels.json maxResponseTokens must be a positive number');
  }
  if (!Array.isArray(raw.heavyModels) || !raw.heavyModels.every((m: unknown) => typeof m === 'string')) {
    throw new Error('config/aiModels.json heavyModels must be a string[]');
  }
  const concurrency = raw.concurrency as any;
  if (!concurrency || typeof concurrency.maxConcurrentHeavyModels !== 'number' || typeof concurrency.maxQueueDepth !== 'number') {
    throw new Error('config/aiModels.json missing/invalid concurrency block');
  }
  const rawRoutes = raw.routes as Record<string, any>;
  if (!rawRoutes || typeof rawRoutes !== 'object') {
    throw new Error('config/aiModels.json missing routes');
  }
  const routes: Record<string, AiModelRoute> = {};
  for (const [agentType, r] of Object.entries(rawRoutes)) {
    if (typeof r?.model !== 'string' || typeof r?.temperature !== 'number' || typeof r?.timeoutMs !== 'number' || !Array.isArray(r?.fallback)) {
      throw new Error(`config/aiModels.json routes.${agentType} is malformed`);
    }
    routes[agentType] = {
      model: r.model,
      temperature: r.temperature,
      timeoutMs: r.timeoutMs,
      fallback: r.fallback,
      rationale: typeof r.rationale === 'string' ? r.rationale : '',
    };
  }

  return {
    ollama: { baseUrl: ollama.baseUrl, keepAlive: ollama.keepAlive, enabled: ollama.enabled },
    researchTimeoutMs: raw.researchTimeoutMs as number,
    maxResponseTokens: raw.maxResponseTokens as number,
    heavyModels: raw.heavyModels as string[],
    concurrency: { maxConcurrentHeavyModels: concurrency.maxConcurrentHeavyModels, maxQueueDepth: concurrency.maxQueueDepth },
    routes,
  };
}

export const aiModels: AiModelsConfig = loadAiModels();

export function isHeavyModel(model: string | undefined): boolean {
  return !!model && aiModels.heavyModels.includes(model);
}

export function isResearchAgentType(agentType: string): boolean {
  return RESEARCH_AGENT_TYPES.has(agentType);
}
