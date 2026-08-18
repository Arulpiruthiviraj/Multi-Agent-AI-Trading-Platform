/**
 * ==========================================================
 * Module: strategiesEngine/generators/ParameterSpace
 *
 * Purpose:
 * Lazy iteration over a strategy's parameter space (Section 13). `candidateValues` expands one
 * parameter's own `values`/`range` into a concrete array (bounded - a range is a real arithmetic
 * sequence, not an unbounded stream). `parameterCombinations` is a lazy generator over the
 * Cartesian product of several parameters' candidate values, computed one combination at a time
 * via a JS generator function - the full product is never materialized as an array, so a caller
 * can `take()` a bounded number without the engine ever allocating the whole space in memory.
 * ==========================================================
 */
import { StrategyParameterDef } from '../core/types';

export function candidateValues(def: StrategyParameterDef): Array<number | string | boolean> {
  if (def.values && def.values.length > 0) return def.values;
  if (def.range) {
    const out: number[] = [];
    const { min, max, step } = def.range;
    // Real, bounded arithmetic sequence - guards against a pathological step of 0 producing an
    // infinite loop (validateStrategy already rejects step<=0, this is a defensive second guard).
    if (step <= 0) return [min];
    for (let v = min; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e9) / 1e9);
    return out;
  }
  return [def.default];
}

/** Total size of the Cartesian product across `defs` - computed by multiplication, never by
 *  materializing the product, so this is cheap even for a very large space. */
export function parameterSpaceSize(defs: StrategyParameterDef[]): number {
  return defs.reduce((acc, d) => acc * candidateValues(d).length, 1);
}

/**
 * Lazily yields every combination of `defs`' candidate values as a { name: value } record, in a
 * deterministic (odometer) order - the same `defs` array always yields the same sequence, which
 * is what makes bounded/seeded generation (Section 29) reproducible upstream in
 * StrategyVariantGenerator.
 */
export function* parameterCombinations(defs: StrategyParameterDef[]): Generator<Record<string, number | string | boolean>> {
  if (defs.length === 0) {
    yield {};
    return;
  }
  const valueLists = defs.map(candidateValues);
  const indices = new Array(defs.length).fill(0);

  while (true) {
    const combo: Record<string, number | string | boolean> = {};
    for (let i = 0; i < defs.length; i++) combo[defs[i].name] = valueLists[i][indices[i]];
    yield combo;

    let pos = defs.length - 1;
    while (pos >= 0) {
      indices[pos]++;
      if (indices[pos] < valueLists[pos].length) break;
      indices[pos] = 0;
      pos--;
    }
    if (pos < 0) return; // wrapped all the way around - exhausted
  }
}

/** Bounded materialization helper - pulls at most `limit` items from any generator/iterable
 *  without ever fully consuming an unbounded or very large source. */
export function take<T>(iterable: Iterable<T>, limit: number): T[] {
  const out: T[] = [];
  for (const item of iterable) {
    if (out.length >= limit) break;
    out.push(item);
  }
  return out;
}
