import { createHash } from 'node:crypto';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import { quantThresholds } from '../config/quantThresholds';
import { STRATEGY_TYPICAL_HOLDING_PERIOD } from '../quant/strategies/types';
import { executionModelVersion, getExecutionModel } from './executionModel';

export interface StrategySpecFile {
  version: string;
  family: string;
  sourceFile: string;
  vectorbtParity: 'PROXY_NOT_FEATURE_PARITY' | 'PARITY' | 'FEATURE_TRANSLATION' | 'FEATURE_PARITY_ESTABLISHED' | 'FEATURE_SUBSET_PARITY';
  validationStatus?: string;
  timeframes: string[];
  features: string[];
  entryRules: string[];
  exitRules: string[];
  stopLoss: string;
  takeProfit: string;
  positionSizing: string;
  maxHoldingPeriod: string;
  thresholdKeys: string[];
}

const raw = loadRepoConfigJson<Record<string, StrategySpecFile>>('strategySpecs.json');

export function loadStrategySpec(strategyId: string): Record<string, unknown> | null {
  const spec = raw[strategyId];
  if (!spec) return null;
  const thresholds: Record<string, number> = {};
  for (const k of spec.thresholdKeys) {
    const v = (quantThresholds as unknown as Record<string, unknown>)[k];
    if (typeof v === 'number') thresholds[k] = v;
  }
  const holdKey = spec.maxHoldingPeriod.replace('STRATEGY_TYPICAL_HOLDING_PERIOD.', '');
  return {
    strategyId,
    ...spec,
    thresholds,
    typicalHoldingPeriod: STRATEGY_TYPICAL_HOLDING_PERIOD[holdKey] ?? spec.maxHoldingPeriod,
    inventedRules: false,
  };
}

export function freezeStrategyVersion(strategyId: string, executionModelId = 'NEXT_BAR_OPEN'): {
  strategyId: string;
  strategyVersion: string;
  executionModel: string;
  executionModelVersion: string;
  configHash: string;
  createdAt: string;
} | null {
  const spec = loadStrategySpec(strategyId);
  if (!spec) return null;
  const payload = {
    strategyId,
    spec,
    executionModel: getExecutionModel(executionModelId),
    executionModelVersion: executionModelVersion(),
  };
  const configHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return {
    strategyId,
    strategyVersion: `${strategyId}-${String(spec.version)}-${configHash.slice(0, 12)}`,
    executionModel: getExecutionModel(executionModelId).executionModel,
    executionModelVersion: executionModelVersion(),
    configHash: `sha256:${configHash}`,
    createdAt: 'config-derived',
  };
}

export function listStrategySpecIds(): string[] {
  return Object.keys(raw).filter((k) => k !== '$comment');
}
