/**
 * ==========================================================
 * Module: strategiesEngine/validation/validateStrategy
 *
 * Purpose:
 * Structural + compatibility validation for a StrategyDefinition (Section 14). Returns a
 * structured result (errors/warnings), never throws for a merely-invalid-but-well-formed input -
 * callers decide whether to reject or just warn. A definition failing validation is never
 * registered by StrategyRegistry.register() (see registry/StrategyRegistry.ts).
 * ==========================================================
 */
import { StrategyDefinition, ValidationIssue, StrategyValidationResult, StrategyParameterDef } from '../core/types';
import { ConditionNode } from '../conditions/ConditionTypes';

function walkConditionDepth(node: ConditionNode, seen: Set<ConditionNode>, depth: number, maxDepth: number): string | null {
  if (depth > maxDepth) return `Condition tree exceeds max depth ${maxDepth} - likely a circular composition.`;
  if (seen.has(node)) return 'Circular condition composition detected (a node references itself).';
  if (node.kind === 'composite') {
    const nextSeen = new Set(seen);
    nextSeen.add(node);
    if (node.op === 'NOT' && node.children.length !== 1) {
      return `NOT must have exactly 1 child, found ${node.children.length}.`;
    }
    if (node.children.length === 0) {
      return `Composite ${node.op} has no children.`;
    }
    for (const child of node.children) {
      const err = walkConditionDepth(child, nextSeen, depth + 1, maxDepth);
      if (err) return err;
    }
  }
  return null;
}

function validateParameterDef(p: StrategyParameterDef, index: number, errors: ValidationIssue[]): void {
  const path = `parameters[${index}]`;
  if (!p.name) errors.push({ path, message: 'Parameter missing name.', severity: 'error' });
  if (!p.values && !p.range) {
    errors.push({ path, message: `Parameter '${p.name}' has neither values[] nor range - no candidate space to generate from.`, severity: 'error' });
  }
  if (p.range) {
    if (p.range.step <= 0) errors.push({ path, message: `Parameter '${p.name}' range.step must be > 0.`, severity: 'error' });
    if (p.range.min > p.range.max) errors.push({ path, message: `Parameter '${p.name}' range.min > range.max.`, severity: 'error' });
  }
  if (p.values && p.values.length === 0) {
    errors.push({ path, message: `Parameter '${p.name}' values[] is empty.`, severity: 'error' });
  }
}

export function validateStrategy(strategy: StrategyDefinition): StrategyValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Defensive shape checks first - validateStrategy is the real gate deserializeStrategy() runs
  // arbitrary parsed JSON through (serialization/serialize.ts), so a malformed/incomplete object
  // must produce structured errors here, never a raw TypeError from deeper field access below.
  if (!strategy || typeof strategy !== 'object') {
    return { valid: false, errors: [{ path: '(root)', message: 'Strategy is not an object.', severity: 'error' }], warnings: [] };
  }
  if (!Array.isArray(strategy.parameters)) {
    errors.push({ path: 'parameters', message: 'parameters must be an array.', severity: 'error' });
  }
  if (!strategy.parameterValues || typeof strategy.parameterValues !== 'object') {
    errors.push({ path: 'parameterValues', message: 'parameterValues must be an object.', severity: 'error' });
  }
  if (!strategy.metadata || typeof strategy.metadata !== 'object' || !Array.isArray(strategy.metadata.tags)) {
    errors.push({ path: 'metadata', message: 'metadata (with a tags array) is required.', severity: 'error' });
  }
  if (!strategy.stopLoss || typeof strategy.stopLoss !== 'object') {
    errors.push({ path: 'stopLoss', message: 'Risk definition (stopLoss) is required.', severity: 'error' });
  }
  if (errors.length > 0) {
    // Structure is too broken to safely walk further (parameters/tags/stopLoss loops below all
    // assume these shapes) - return what's already found rather than risking a second crash.
    return { valid: false, errors, warnings };
  }

  if (!strategy.name) errors.push({ path: 'name', message: 'Strategy name is required.', severity: 'error' });
  if (!strategy.family) errors.push({ path: 'family', message: 'Strategy family is required.', severity: 'error' });
  if (!Number.isInteger(strategy.version) || strategy.version < 1) {
    errors.push({ path: 'version', message: 'version must be an integer >= 1.', severity: 'error' });
  }

  if (!strategy.entryConditions) {
    errors.push({ path: 'entryConditions', message: 'entryConditions must not be empty.', severity: 'error' });
  } else {
    const err = walkConditionDepth(strategy.entryConditions, new Set(), 0, 32);
    if (err) errors.push({ path: 'entryConditions', message: err, severity: 'error' });
  }

  for (const [key, node] of [
    ['confirmationConditions', strategy.confirmationConditions],
    ['invalidationConditions', strategy.invalidationConditions],
    ['exitConditions', strategy.exitConditions],
  ] as const) {
    if (node) {
      const err = walkConditionDepth(node, new Set(), 0, 32);
      if (err) errors.push({ path: key, message: err, severity: 'error' });
    }
  }

  if (!strategy.exitConditions && strategy.takeProfit === null && strategy.stopLoss.kind !== 'STRUCTURE') {
    // Real exit logic exists (Section 14 "exit logic exists") if ANY of exitConditions/takeProfit/
    // a structural stop is present - a bare stop-loss floor alone still counts as SOME exit logic
    // (stopLoss is required and always present), so this only warns, it does not error, when the
    // strategy relies solely on the required stopLoss with no richer exit plan.
    warnings.push({ path: 'exitConditions', message: 'No exitConditions/takeProfit defined - this strategy exits only via its stopLoss.', severity: 'warning' });
  }

  strategy.parameters.forEach((p, i) => validateParameterDef(p, i, errors));

  const paramNames = new Set(strategy.parameters.map(p => p.name));
  for (const key of Object.keys(strategy.parameterValues)) {
    if (!paramNames.has(key)) {
      warnings.push({ path: `parameterValues.${key}`, message: `parameterValues has '${key}' with no matching entry in parameters[].`, severity: 'warning' });
    }
  }

  if (strategy.implementationStatus === 'METADATA_ONLY' && strategy.metadata.origin !== 'BASE') {
    errors.push({
      path: 'implementationStatus',
      message: 'Only BASE strategies may be METADATA_ONLY - a generated/variant strategy must be REAL (fully evaluable) or it should not have been generated.',
      severity: 'error',
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}
