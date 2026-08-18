/**
 * ==========================================================
 * Module: strategiesEngine/serialization/serialize
 *
 * Purpose:
 * StrategyDefinition is already plain, function-free JSON data (ConditionNode included), so
 * serialization is a real JSON.stringify/parse round-trip - not a bespoke format. `deserializeStrategy`
 * re-validates after parsing (a malformed/tampered JSON blob must fail loudly, not silently become
 * a strategy with missing fields) and re-derives the id from the parsed content, rejecting the
 * blob if the embedded id doesn't match its own content hash (tamper/corruption detection, since
 * core/id.ts's hash is exactly the definition of "what this strategy's identity is").
 * ==========================================================
 */
import { StrategyDefinition } from '../core/types';
import { computeStrategyId } from '../core/id';
import { validateStrategy } from '../validation/validateStrategy';

export function serializeStrategy(strategy: StrategyDefinition): string {
  return JSON.stringify(strategy);
}

export class DeserializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeserializationError';
  }
}

export function deserializeStrategy(json: string): StrategyDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new DeserializationError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DeserializationError('Parsed value is not an object.');
  }
  const strategy = parsed as StrategyDefinition;

  const result = validateStrategy(strategy);
  if (!result.valid) {
    throw new DeserializationError(`Deserialized strategy failed validation: ${result.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
  }

  const expectedId = computeStrategyId({
    family: strategy.family,
    name: strategy.name,
    version: strategy.version,
    entryConditions: strategy.entryConditions,
    confirmationConditions: strategy.confirmationConditions,
    invalidationConditions: strategy.invalidationConditions,
    exitConditions: strategy.exitConditions,
    stopLoss: strategy.stopLoss,
    takeProfit: strategy.takeProfit,
    positionSizing: strategy.positionSizing,
    parameterValues: strategy.parameterValues,
  });
  if (expectedId !== strategy.id) {
    throw new DeserializationError(`Strategy id '${strategy.id}' does not match its content hash (expected '${expectedId}') - the JSON was hand-edited or corrupted after creation.`);
  }

  return Object.freeze(strategy);
}
