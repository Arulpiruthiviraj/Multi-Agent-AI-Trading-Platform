import { describe, it, expect } from 'vitest';
import { candidateValues, parameterSpaceSize, parameterCombinations, take } from './ParameterSpace';
import { StrategyParameterDef } from '../core/types';

describe('candidateValues', () => {
  it('expands a range into a real arithmetic sequence', () => {
    const def: StrategyParameterDef = { name: 'x', type: 'number', range: { min: 10, max: 20, step: 5 }, default: 10 };
    expect(candidateValues(def)).toEqual([10, 15, 20]);
  });

  it('uses values[] when present', () => {
    const def: StrategyParameterDef = { name: 'x', type: 'enum', values: ['a', 'b', 'c'], default: 'a' };
    expect(candidateValues(def)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to [default] when neither is present', () => {
    const def: StrategyParameterDef = { name: 'x', type: 'number', default: 42 };
    expect(candidateValues(def)).toEqual([42]);
  });
});

describe('parameterSpaceSize', () => {
  it('multiplies candidate counts across parameters', () => {
    const defs: StrategyParameterDef[] = [
      { name: 'a', type: 'number', range: { min: 1, max: 5, step: 1 }, default: 1 }, // 5 values
      { name: 'b', type: 'enum', values: ['x', 'y', 'z'], default: 'x' }, // 3 values
    ];
    expect(parameterSpaceSize(defs)).toBe(15);
  });

  it('is 1 for an empty parameter list', () => {
    expect(parameterSpaceSize([])).toBe(1);
  });
});

describe('parameterCombinations', () => {
  it('yields the full Cartesian product exactly once each', () => {
    const defs: StrategyParameterDef[] = [
      { name: 'a', type: 'enum', values: [1, 2], default: 1 },
      { name: 'b', type: 'enum', values: ['x', 'y'], default: 'x' },
    ];
    const combos = Array.from(parameterCombinations(defs));
    expect(combos.length).toBe(4);
    const keys = new Set(combos.map(c => `${c.a}:${c.b}`));
    expect(keys).toEqual(new Set(['1:x', '1:y', '2:x', '2:y']));
  });

  it('is lazy - take() never forces the full space', () => {
    const defs: StrategyParameterDef[] = [
      { name: 'a', type: 'number', range: { min: 1, max: 1_000_000, step: 1 }, default: 1 },
    ];
    // If this were eager, materializing 1,000,000 values would be slow/allocate heavily.
    // We instead build the generator lazily; only `take` should force iteration.
    const gen = parameterCombinations(defs);
    const first3 = take(gen, 3);
    expect(first3).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('deterministic order - same defs always yield the same sequence', () => {
    const defs: StrategyParameterDef[] = [{ name: 'a', type: 'enum', values: [1, 2, 3], default: 1 }];
    const a = Array.from(parameterCombinations(defs));
    const b = Array.from(parameterCombinations(defs));
    expect(a).toEqual(b);
  });

  it('yields one empty combination for zero parameters', () => {
    expect(Array.from(parameterCombinations([]))).toEqual([{}]);
  });
});
