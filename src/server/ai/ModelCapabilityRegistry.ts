/**
 * ==========================================================
 * Module: ModelCapabilityRegistry
 *
 * Purpose:
 * A real, static registry of the models actually integrated in this codebase today, what task
 * category each one is good for, and whether it's currently allowed to influence a live trading
 * decision. Deliberately does NOT list aspirational models (FinGPT/Plutus/a second forecaster) -
 * this is an inventory of what exists and runs, not a roadmap. `liveEligible: false` entries exist
 * (XGBoost) precisely so a future change can't silently start using an unvalidated model without
 * updating this file's own honest assessment of it.
 * ==========================================================
 */

export type ModelCapability =
  | 'technical'               // deterministic indicator math (RSI/MACD/SMA/Bollinger/ATR)
  | 'sentiment'                // financial text sentiment scoring
  | 'forecasting'              // time-series price forecasting
  | 'direction_classification' // structured feature -> up/down classification
  | 'reasoning'                // general/financial reasoning over unstructured text
  | 'structured_extraction';   // reasoning constrained to a strict output schema (e.g. JSON)

export interface ModelCapabilityEntry {
  id: string;
  name: string;
  capabilities: ModelCapability[];
  local: boolean;
  costPerCall: 'free' | 'paid';
  liveEligible: boolean;
  liveEligibleReason: string;
}

export const MODEL_CAPABILITY_REGISTRY: ModelCapabilityEntry[] = [
  {
    id: 'deterministic_technical',
    name: 'RSI/MACD/SMA/Bollinger (RSIEngine/MACDEngine, used by TechnicalAgent + BacktestEngine)',
    capabilities: ['technical'],
    local: true,
    costPerCall: 'free',
    liveEligible: true,
    liveEligibleReason: 'Deterministic math, unit-tested, already live in TechnicalAgent.',
  },
  {
    id: 'finbert',
    name: 'FinBERT (ProsusAI/finbert, served by scripts/local_ai_service.py)',
    capabilities: ['sentiment'],
    local: true,
    costPerCall: 'free',
    liveEligible: true,
    liveEligibleReason: 'Live-verified this engagement; feeds NewsImpactEngine\'s real sentiment score.',
  },
  {
    id: 'chronos',
    name: 'Amazon Chronos (amazon/chronos-t5-mini, served by scripts/local_ai_service.py)',
    capabilities: ['forecasting'],
    local: true,
    costPerCall: 'free',
    liveEligible: true,
    liveEligibleReason: 'Live-verified real BUY/SELL/HOLD forecasts via KronosForecastAgent.',
  },
  {
    id: 'xgboost_direction',
    name: 'XGBoost direction classifier (scripts/train_xgboost_direction.py)',
    capabilities: ['direction_classification'],
    local: true,
    costPerCall: 'free',
    liveEligible: false,
    liveEligibleReason: 'Trained and walk-forward evaluated (56.7% vs 53.3%/50% baselines); the ' +
      'accuracy\'s own 95% CI overlaps the naive baseline - not statistically distinguishable from ' +
      'noise at this sample size, so it is not wired into any agent.',
  },
  {
    id: 'ollama_llama3_2',
    name: 'Ollama llama3.2 (local OpenAI-compatible endpoint, http://localhost:11434/v1)',
    capabilities: ['reasoning', 'structured_extraction'],
    local: true,
    costPerCall: 'free',
    liveEligible: true,
    liveEligibleReason: 'Live in NewsAgent via a persisted agent_routing_overrides row; JSON mode ' +
      'requested for structured extraction, though the model still fails a real fraction of the time.',
  },
  {
    id: 'paid_llm_pool',
    name: 'Gemini / OpenAI / DeepSeek / Nvidia / generic OpenAI-compatible (AIRouter\'s failover pool)',
    capabilities: ['reasoning'],
    local: false,
    costPerCall: 'paid',
    liveEligible: true,
    liveEligibleReason: 'Real per-call cost tracking via estimateCost(); per-provider health is ' +
      'tracked dynamically at runtime (aiProviders.health), not statically declared here.',
  },
];

export function getModelsForCapability(capability: ModelCapability): ModelCapabilityEntry[] {
  return MODEL_CAPABILITY_REGISTRY.filter(m => m.capabilities.includes(capability));
}

export function getLiveEligibleLocalModel(capability: ModelCapability): ModelCapabilityEntry | null {
  return MODEL_CAPABILITY_REGISTRY.find(m => m.capabilities.includes(capability) && m.local && m.liveEligible) || null;
}
