/**
 * LLM Research role (Section 8/10/28). The LLM proposes a structured hypothesis — it is NEVER
 * the final authority: every proposed parameterValues set is schema/bounds-validated against the
 * parent's own declared StrategyParameterDef[] before being accepted, exactly like a mutation
 * candidate. Malformed/hallucinated/out-of-bounds output is rejected and this function falls back
 * to pure bounded mutation (ParameterMutation.ts) — LLM failure never stops candidate generation
 * and never causes unsafe fallback behavior (never widens bounds, never bypasses validation).
 */
import { randomUUID } from 'crypto';
import { AIRouter } from '../../ai/AIRouter';
import type { StrategyDefinition, StrategyParameterDef } from '../../strategiesEngine/core/types';
import { generateBoundedMutations, type MutationCandidate } from './ParameterMutation';

function isValueInBounds(value: unknown, def: StrategyParameterDef): value is number | string | boolean {
  if (def.type === 'number' || def.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (def.range) return value >= def.range.min && value <= def.range.max;
    return def.values ? def.values.includes(value) : true;
  }
  if (def.values) return def.values.includes(value as any);
  return typeof value === typeof def.default;
}

/** Real schema + bounds validation — the gate between "LLM said so" and "accepted as a candidate". */
export function validateHypothesisParameters(
  parent: StrategyDefinition,
  proposed: unknown,
): { ok: true; parameterValues: Record<string, number | string | boolean> } | { ok: false; reason: string } {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) {
    return { ok: false, reason: 'LLM output is not a JSON object.' };
  }
  const proposedValues = proposed as Record<string, unknown>;
  const result: Record<string, number | string | boolean> = { ...parent.parameterValues };
  let changedAny = false;
  for (const def of parent.parameters) {
    if (!(def.name in proposedValues)) continue;
    const candidate = proposedValues[def.name];
    if (!isValueInBounds(candidate, def)) {
      return { ok: false, reason: `Proposed ${def.name}=${JSON.stringify(candidate)} is outside its declared bounds — rejected, not clamped.` };
    }
    result[def.name] = candidate;
    changedAny = true;
  }
  if (!changedAny) {
    return { ok: false, reason: 'LLM proposal changed no known, declared parameter.' };
  }
  return { ok: true, parameterValues: result };
}

export interface HypothesisResult {
  candidates: MutationCandidate[];
  source: 'LLM_HYPOTHESIS' | 'MUTATION_FALLBACK';
  llmReasoning: string | null;
}

/**
 * Attempts one real LLM-authored hypothesis; on ANY failure (unavailable, timeout, malformed
 * JSON, out-of-bounds values, hallucinated parameter names) falls back to pure bounded mutation —
 * trading continuity is never affected either way, since neither path touches the live spine.
 */
export async function generateHypothesis(parent: StrategyDefinition, opts: { maxCandidates?: number } = {}): Promise<HypothesisResult> {
  try {
    const traceId = `evolution-hypothesis-${randomUUID()}`;
    const paramList = parent.parameters.map((p) => `${p.name} (${p.type}${p.range ? `, range ${p.range.min}-${p.range.max} step ${p.range.step}` : p.values ? `, values ${JSON.stringify(p.values)}` : ''})`).join('; ');
    const prompt = `Strategy "${parent.name}" (family ${parent.family}) has these declared, tunable parameters: ${paramList}. Current values: ${JSON.stringify(parent.parameterValues)}. Propose ONE small parameter change you believe could improve out-of-sample performance, staying strictly within each parameter's declared bounds. Return ONLY strict JSON: {"parameterValues": {...changed params only...}, "reasoning": "one sentence"}. Do not invent new parameter names.`;
    const res = await AIRouter.getInstance().routeTask('EvolutionHypothesis', prompt, traceId);
    if (!res.content) throw new Error('empty LLM response');
    const parsed = JSON.parse(res.content);
    const validated = validateHypothesisParameters(parent, parsed?.parameterValues);
    if (validated.ok === false) throw new Error(validated.reason);
    const validatedValues = validated.parameterValues;
    return {
      candidates: [{
        parameterValues: validatedValues,
        changedParameter: Object.keys(parsed.parameterValues)[0] ?? 'unknown',
        reason: `LLM hypothesis: ${typeof parsed.reasoning === 'string' ? parsed.reasoning : 'no reasoning provided'}`,
      }],
      source: 'LLM_HYPOTHESIS',
      llmReasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : null,
    };
  } catch (e: any) {
    return {
      candidates: generateBoundedMutations(parent, opts),
      source: 'MUTATION_FALLBACK',
      llmReasoning: `LLM hypothesis unavailable/invalid (${e?.message || e}) — fell back to bounded mutation.`,
    };
  }
}
