/**
 * ==========================================================
 * Module: strategiesEngine (public API)
 *
 * Purpose:
 * The Strategies Engine's public surface (Section 23). A strategy-DEFINITION/research subsystem -
 * no broker/order-execution methods are exposed here, and nothing in this file (or anything it
 * imports) reaches ChiefTraderAgent, RiskAgent, OrderManagementService, BrokerManager, or
 * EventBus. See STRATEGIES_ENGINE.md for the full isolation contract and how a FUTURE phase would
 * connect this safely (via an explicit, separate adapter - not by importing this engine directly
 * into the live path, and not by this engine importing the live path).
 * ==========================================================
 */
import { StrategyRegistry, StrategySearchCriteria } from './registry/StrategyRegistry';
import { StrategyDefinition, StrategyFamily } from './core/types';
import { BASE_STRATEGIES, REAL_TEMPLATES, METADATA_ONLY_FAMILIES } from './families/catalog';
import { generateVariantsAcrossTemplates, GenerateVariantsOptions } from './generators/StrategyVariantGenerator';
import { LEAF_CONDITION_TYPES } from './conditions/conditionCatalog';

export * from './core/types';
export * from './core/MarketSnapshot';
export * from './core/id';
export * from './core/createStrategy';
export * from './core/StrategyPerformance';
export * from './conditions/ConditionTypes';
export * from './conditions/evaluateCondition';
export * from './conditions/conditionCatalog';
export * from './validation/validateStrategy';
export * from './serialization/serialize';
export * from './registry/StrategyRegistry';
export * from './generators/ParameterSpace';
export * from './generators/StrategyVariantGenerator';
export * from './families/catalog';

/** One process-wide default registry, seeded with every real BASE strategy. Callers needing
 *  isolation (tests, multiple independent catalogs) should construct their own
 *  `new StrategyRegistry()` instead of using this singleton. */
export const defaultRegistry = new StrategyRegistry();
defaultRegistry.registerMany(BASE_STRATEGIES);

export function registerStrategy(strategy: StrategyDefinition): StrategyDefinition {
  return defaultRegistry.register(strategy);
}

export function getStrategy(id: string): StrategyDefinition | undefined {
  return defaultRegistry.get(id);
}

export function findStrategies(criteria: StrategySearchCriteria): StrategyDefinition[] {
  return defaultRegistry.search(criteria);
}

export function listStrategyFamilies(): StrategyFamily[] {
  return defaultRegistry.listFamilies();
}

export function getStrategyCount(): number {
  return defaultRegistry.count();
}

/** Real counts, per Section 27 - never a bare "10,000 strategies" claim without the breakdown
 *  that produced it. */
export interface StrategiesEngineStats {
  baseStrategies: number;
  realTemplates: number;
  metadataOnlyFamilies: number;
  conditionPrimitives: number;
  totalVariantSpaceSize: number;
}

export function getEngineStats(): StrategiesEngineStats {
  const spaceProbe = generateVariantsAcrossTemplates(REAL_TEMPLATES, { limit: 0 });
  return {
    baseStrategies: BASE_STRATEGIES.length,
    realTemplates: REAL_TEMPLATES.length,
    metadataOnlyFamilies: METADATA_ONLY_FAMILIES.length,
    conditionPrimitives: LEAF_CONDITION_TYPES.length,
    totalVariantSpaceSize: spaceProbe.totalSpaceSize,
  };
}

/** Generates real variants across every seeded template and registers them into `registry`
 *  (defaults to the shared defaultRegistry). Thin convenience wrapper over
 *  generateVariantsAcrossTemplates + registerMany - Section 23's `generateStrategies()`. */
export function generateStrategies(opts: GenerateVariantsOptions = {}, registry: StrategyRegistry = defaultRegistry): {
  generated: StrategyDefinition[];
  skipped: Array<{ id: string; reason: string }>;
  totalSpaceSize: number;
  truncated: boolean;
} {
  const result = generateVariantsAcrossTemplates(REAL_TEMPLATES, opts);
  const { registered, skipped } = registry.registerMany(result.variants);
  return { generated: registered, skipped, totalSpaceSize: result.totalSpaceSize, truncated: result.truncated };
}
