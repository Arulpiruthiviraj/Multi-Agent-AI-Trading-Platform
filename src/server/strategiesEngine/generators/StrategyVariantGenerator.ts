/**
 * ==========================================================
 * Module: strategiesEngine/generators/StrategyVariantGenerator
 *
 * Purpose:
 * Turns one StrategyTemplate (a real condition-tree BUILDER function + a parameter space) into
 * many concrete StrategyDefinition variants - Section 8/9's "generic strategy-generation
 * framework" without writing N hand-authored classes. `template.build(values)` is real code that
 * constructs a genuinely different, machine-testable condition tree per parameter combination
 * (e.g. a different EMA period wired into an actual CrossAbove condition) - this is NOT the
 * "same rule, different name" pattern Section 27 explicitly forbids counting as distinct
 * strategies; two combinations only differ if `build()` actually produces different conditions.
 *
 * Uniqueness is guaranteed by construction, not by a runtime duplicate-scan: `createStrategy`'s id
 * is a hash of the full condition tree + parameterValues (core/id.ts), so two variants can only
 * collide if `build()` produced byte-identical output for two different parameter combinations -
 * a real bug in the template, which `generateVariants`'s dedup pass below still catches and
 * reports rather than silently registering a duplicate.
 * ==========================================================
 */
import {
  StrategyDefinition, StrategyFamily, StrategyMetadata, StrategyParameterDef,
  ImplementationStatus, StopLossRule, TakeProfitRule, PositionSizingRule,
} from '../core/types';
import { ConditionNode } from '../conditions/ConditionTypes';
import { createStrategy } from '../core/createStrategy';
import { parameterCombinations, parameterSpaceSize, take } from './ParameterSpace';

export interface StrategyTemplateBuildResult {
  entryConditions: ConditionNode;
  confirmationConditions: ConditionNode | null;
  invalidationConditions: ConditionNode | null;
  exitConditions: ConditionNode | null;
  stopLoss: StopLossRule;
  takeProfit: TakeProfitRule | null;
  positionSizing: PositionSizingRule;
  requiredIndicators: string[];
}

export interface StrategyTemplate {
  baseName: string;
  family: StrategyFamily;
  implementationStatus: ImplementationStatus;
  parameters: StrategyParameterDef[];
  build: (values: Record<string, number | string | boolean>) => StrategyTemplateBuildResult;
  metadata: Omit<StrategyMetadata, 'createdAt' | 'origin' | 'derivedFromId'>;
}

export interface GenerateVariantsOptions {
  /** Hard cap on how many variants are produced - the full Cartesian product is never
   *  materialized regardless of this value (ParameterSpace.parameterCombinations is lazy), so
   *  `limit` bounds real work done, not just the returned array size. */
  limit?: number;
}

export interface GenerateVariantsResult {
  variants: StrategyDefinition[];
  totalSpaceSize: number;
  truncated: boolean;
  duplicateIds: string[]; // non-empty only if `build()` produced identical output for >1 combination
}

export function generateVariants(template: StrategyTemplate, opts: GenerateVariantsOptions = {}): GenerateVariantsResult {
  const totalSpaceSize = parameterSpaceSize(template.parameters);
  const limit = opts.limit ?? totalSpaceSize;
  const combos = take(parameterCombinations(template.parameters), limit);

  const variants: StrategyDefinition[] = [];
  const seenIds = new Set<string>();
  const duplicateIds: string[] = [];

  for (const values of combos) {
    const built = template.build(values);
    const strategy = createStrategy({
      name: template.baseName,
      family: template.family,
      implementationStatus: template.implementationStatus,
      requiredIndicators: built.requiredIndicators,
      entryConditions: built.entryConditions,
      confirmationConditions: built.confirmationConditions,
      invalidationConditions: built.invalidationConditions,
      stopLoss: built.stopLoss,
      takeProfit: built.takeProfit,
      exitConditions: built.exitConditions,
      positionSizing: built.positionSizing,
      parameters: template.parameters,
      parameterValues: values,
      dependencies: [],
      metadata: { ...template.metadata, origin: 'GENERATED' },
    });

    if (seenIds.has(strategy.id)) {
      duplicateIds.push(strategy.id);
      continue;
    }
    seenIds.add(strategy.id);
    variants.push(strategy);
  }

  return { variants, totalSpaceSize, truncated: totalSpaceSize > limit, duplicateIds };
}

/** Generates variants across several templates in one call, summing each template's contribution
 *  - the multi-family composition Section 9 describes (trend + momentum + volume confirmation
 *  etc. as separate templates whose combined output is the real variant catalog), without a
 *  combinatorial explosion across UNRELATED templates (each template's own parameter space stays
 *  its own bounded product, rather than every template's parameters cross-multiplying with every
 *  other template's - that cross-product is exactly the "garbage combination" risk Section 9 warns
 *  about, since e.g. an options template's parameters have no real meaning combined with a trend
 *  template's).
 */
export function generateVariantsAcrossTemplates(templates: StrategyTemplate[], opts: GenerateVariantsOptions = {}): GenerateVariantsResult {
  // `limit` is a GLOBAL cap across all templates combined (not per-template) - a caller asking
  // for "500 strategies" gets at most 500 total, spent across templates in order, not up to
  // 500 PER template. `totalSpaceSize` is still the real full-space sum regardless of the cap.
  const globalLimit = opts.limit;
  let remaining = globalLimit;
  const results: GenerateVariantsResult[] = [];

  for (const template of templates) {
    const templateLimit = remaining === undefined ? undefined : Math.max(0, remaining);
    const result = generateVariants(template, { limit: templateLimit });
    results.push(result);
    if (remaining !== undefined) remaining -= result.variants.length;
  }

  const totalSpaceSize = results.reduce((sum, r) => sum + r.totalSpaceSize, 0);
  return {
    variants: results.flatMap(r => r.variants),
    totalSpaceSize,
    truncated: globalLimit !== undefined && totalSpaceSize > globalLimit,
    duplicateIds: results.flatMap(r => r.duplicateIds),
  };
}
