import { describe, it, expect } from 'vitest';
import { serializeStrategy, deserializeStrategy, DeserializationError } from './serialize';
import { createStrategy } from '../core/createStrategy';
import { leaf, and } from '../conditions/ConditionTypes';

function makeStrategy() {
  return createStrategy({
    name: 'Round Trip Strategy',
    family: 'MOMENTUM',
    implementationStatus: 'REAL',
    requiredIndicators: ['rsi14', 'adx'],
    entryConditions: and(leaf('RSIAbove', { value: 50 }), leaf('ADXAbove', { value: 20 })),
    confirmationConditions: leaf('VolumeAboveAverage', { value: 1.5 }),
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: { kind: 'ATR_MULTIPLE', value: 2, basis: 'test' },
    takeProfit: { kind: 'RISK_MULTIPLE', value: 2, basis: 'test' },
    positionSizing: { kind: 'FIXED_FRACTIONAL', value: 0.01, basis: 'test' },
    parameters: [{ name: 'rsiThreshold', type: 'number', range: { min: 40, max: 60, step: 5 }, default: 50 }],
    parameterValues: { rsiThreshold: 50 },
    dependencies: [],
    metadata: { description: 'test', tags: ['test'], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE' },
  });
}

describe('serialize / deserialize round trip', () => {
  it('round-trips a strategy exactly', () => {
    const original = makeStrategy();
    const json = serializeStrategy(original);
    const restored = deserializeStrategy(json);
    expect(restored).toEqual(original);
  });

  it('is real JSON (parseable by JSON.parse independently)', () => {
    const json = serializeStrategy(makeStrategy());
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('rejects malformed JSON', () => {
    expect(() => deserializeStrategy('{not valid json')).toThrow(DeserializationError);
  });

  it('rejects a structurally invalid but valid-JSON blob', () => {
    expect(() => deserializeStrategy(JSON.stringify({ name: 'incomplete' }))).toThrow(DeserializationError);
  });

  it('rejects a tampered id (content hash mismatch)', () => {
    const strategy = makeStrategy();
    const tampered = { ...strategy, id: 'STRAT-FAKE-TAMPERED-00000000-V1' };
    expect(() => deserializeStrategy(JSON.stringify(tampered))).toThrow(/does not match its content hash/);
  });

  it('rejects a tampered condition tree even if the id string format looks valid', () => {
    const strategy = makeStrategy();
    const tampered = { ...strategy, entryConditions: leaf('Always') };
    expect(() => deserializeStrategy(JSON.stringify(tampered))).toThrow(DeserializationError);
  });
});
