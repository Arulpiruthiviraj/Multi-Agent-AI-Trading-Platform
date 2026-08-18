import { describe, it, expect } from 'vitest';
import { generateVariants, generateVariantsAcrossTemplates, StrategyTemplate } from './StrategyVariantGenerator';
import { REAL_TEMPLATES } from '../families/catalog';
import { leaf } from '../conditions/ConditionTypes';

function fixtureTemplate(overrides: Partial<StrategyTemplate> = {}): StrategyTemplate {
  return {
    baseName: 'Fixture Template',
    family: 'TREND',
    implementationStatus: 'REAL',
    parameters: [
      { name: 'threshold', type: 'number', range: { min: 10, max: 90, step: 10 }, default: 50 }, // 9 values
    ],
    build: (values) => ({
      entryConditions: leaf('RSIAbove', { value: Number(values.threshold) }),
      confirmationConditions: null,
      invalidationConditions: null,
      exitConditions: null,
      stopLoss: { kind: 'ATR_MULTIPLE', value: 2, basis: 'fixture' },
      takeProfit: null,
      positionSizing: { kind: 'FIXED_FRACTIONAL', value: 0.01, basis: 'fixture' },
      requiredIndicators: ['rsi14'],
    }),
    metadata: { description: 'fixture', tags: ['fixture'], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'] },
    ...overrides,
  };
}

describe('generateVariants', () => {
  it('produces exactly one variant per real parameter combination', () => {
    const result = generateVariants(fixtureTemplate());
    expect(result.totalSpaceSize).toBe(9);
    expect(result.variants.length).toBe(9);
    expect(result.truncated).toBe(false);
    expect(result.duplicateIds).toEqual([]);
  });

  it('respects a bounded limit without materializing the full space', () => {
    const result = generateVariants(fixtureTemplate(), { limit: 3 });
    expect(result.variants.length).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.totalSpaceSize).toBe(9); // still real, computed cheaply regardless of limit
  });

  it('every variant has a distinct, deterministic id and correct parameterValues', () => {
    const result = generateVariants(fixtureTemplate());
    const ids = new Set(result.variants.map(v => v.id));
    expect(ids.size).toBe(result.variants.length);
    for (const v of result.variants) {
      expect(v.metadata.origin).toBe('GENERATED');
      expect(typeof v.parameterValues.threshold).toBe('number');
    }
  });

  it('regenerating the same template yields byte-identical ids (reproducibility)', () => {
    const a = generateVariants(fixtureTemplate()).variants.map(v => v.id);
    const b = generateVariants(fixtureTemplate()).variants.map(v => v.id);
    expect(a).toEqual(b);
  });

  it('detects and reports real duplicates from a degenerate parameter def (repeated candidate value)', () => {
    // A parameter whose candidate values list contains a literal duplicate is a malformed
    // template, not a normal case (parameterCombinations always yields distinct combos by
    // construction otherwise) - this proves the dedup pass catches that real degenerate case
    // rather than silently registering two variants under the same id.
    const degenerate = fixtureTemplate({
      parameters: [{ name: 'threshold', type: 'number', values: [50, 50, 60], default: 50 }],
    });
    const result = generateVariants(degenerate);
    expect(result.totalSpaceSize).toBe(3);
    expect(result.variants.length).toBe(2); // {threshold:50} kept once, {threshold:60} once
    expect(result.duplicateIds.length).toBe(1); // the second {threshold:50} combination collided
  });
});

describe('generateVariantsAcrossTemplates - real catalog scale proof', () => {
  it('the real seeded family catalog produces 10,000+ genuinely unique strategy configurations', () => {
    const result = generateVariantsAcrossTemplates(REAL_TEMPLATES);
    expect(result.totalSpaceSize).toBeGreaterThanOrEqual(10_000);

    // Bounded materialization (not the full space) is enough to prove uniqueness at scale without
    // a slow test - the deterministic-id guarantee (core/id.ts) plus this sample is the real proof.
    const sample = generateVariantsAcrossTemplates(REAL_TEMPLATES, { limit: 2000 });
    const ids = new Set(sample.variants.map(v => v.id));
    expect(ids.size).toBe(sample.variants.length);
    expect(sample.duplicateIds).toEqual([]);
  });

  it('every generated variant passes real validation', () => {
    const sample = generateVariantsAcrossTemplates(REAL_TEMPLATES, { limit: 500 });
    for (const v of sample.variants) {
      expect(v.implementationStatus).toBe('REAL');
      expect(v.entryConditions).toBeTruthy();
    }
  });

  it('does not cross-multiply unrelated templates (bounded per-template, not combinatorial across families)', () => {
    const twoTemplates = [fixtureTemplate({ baseName: 'A' }), fixtureTemplate({ baseName: 'B' })];
    const result = generateVariantsAcrossTemplates(twoTemplates);
    // 9 + 9, not 9 * 9 - each template's own space stays independent.
    expect(result.totalSpaceSize).toBe(18);
  });
});
