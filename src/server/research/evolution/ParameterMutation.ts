/**
 * Bounded parameter mutation (Section 6). Genuinely new — audit confirmed strategiesEngine's
 * generators/ParameterSpace.ts only does full Cartesian-grid enumeration of a DECLARED space
 * (every combination), never adaptive perturbation of ONE parent's specific values. This is the
 * opposite operation: given a parent's real parameterValues + the strategy's own declared
 * StrategyParameterDef[] bounds (reused, not redefined), produce a small number of nearby
 * candidates by stepping each numeric parameter by ±1 or ±2 declared steps, or swapping to an
 * adjacent discrete value — never brute-force, never unbounded, every output value re-validated
 * against the same declared min/max/values the strategy itself already declares.
 */
import type { StrategyDefinition, StrategyParameterDef } from '../../strategiesEngine/core/types';

export interface MutationCandidate {
  parameterValues: Record<string, number | string | boolean>;
  changedParameter: string;
  reason: string;
}

function clampToRange(value: number, def: StrategyParameterDef): number {
  if (!def.range) return value;
  const { min, max, step } = def.range;
  const stepped = Math.round((value - min) / step) * step + min;
  return Math.min(max, Math.max(min, Number(stepped.toFixed(10))));
}

/** Real, bounded neighbor values for one numeric parameter — never outside its own declared range. */
function numericNeighbors(current: number, def: StrategyParameterDef): number[] {
  if (!def.range) return [];
  const { min, max, step } = def.range;
  const out = new Set<number>();
  for (const delta of [-2, -1, 1, 2]) {
    const candidate = clampToRange(current + delta * step, def);
    if (candidate !== current && candidate >= min && candidate <= max) out.add(candidate);
  }
  return Array.from(out);
}

/** Real, bounded neighbor values for a discrete (string/enum/boolean) parameter — its own declared list only. */
function discreteNeighbors(current: number | string | boolean, def: StrategyParameterDef): Array<number | string | boolean> {
  if (!def.values || def.values.length < 2) return [];
  return def.values.filter((v) => v !== current);
}

/**
 * Generates bounded, single-parameter-changed mutations of `parent`. `maxCandidates` caps output
 * (default 6) — this is deliberately small and local, not a search over the full declared space.
 * Every parameter this function does NOT vary keeps the parent's exact value, so each candidate
 * differs from its parent by exactly one parameter — this keeps lineage/attribution
 * (Section 16 reproducibility) unambiguous: "candidate B came from A after THIS ONE change."
 */
export function generateBoundedMutations(
  parent: StrategyDefinition,
  opts: { maxCandidates?: number } = {},
): MutationCandidate[] {
  const maxCandidates = Math.max(1, Math.min(opts.maxCandidates ?? 6, 20));
  const out: MutationCandidate[] = [];

  for (const def of parent.parameters) {
    if (out.length >= maxCandidates) break;
    const current = parent.parameterValues[def.name] ?? def.default;
    const neighbors: Array<number | string | boolean> =
      def.type === 'number' || def.type === 'integer'
        ? (typeof current === 'number' ? numericNeighbors(current, def) : [])
        : discreteNeighbors(current, def);

    for (const neighbor of neighbors) {
      if (out.length >= maxCandidates) break;
      out.push({
        parameterValues: { ...parent.parameterValues, [def.name]: neighbor },
        changedParameter: def.name,
        reason: `Bounded mutation of ${parent.id}: ${def.name} ${JSON.stringify(current)} → ${JSON.stringify(neighbor)} (within declared bounds)`,
      });
    }
  }

  return out;
}
