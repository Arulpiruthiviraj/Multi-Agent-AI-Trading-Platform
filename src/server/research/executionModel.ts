import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

export interface ExecutionModel {
  executionModel: string;
  commissionModel: string;
  slippageModel: string;
  spreadModel: string;
  latencyModel: string;
  note: string;
}

type ExecutionFile = Record<string, ExecutionModel | string>;

const file = loadRepoConfigJson<ExecutionFile>('executionModels.json');

export function executionModelVersion(): string {
  const v = file.EXECUTION_MODEL_VERSION;
  if (typeof v !== 'string' || !v.startsWith('argus-research-execution-')) {
    throw new Error('config/executionModels.json missing EXECUTION_MODEL_VERSION');
  }
  return v;
}

export function getExecutionModel(id = 'NEXT_BAR_OPEN'): ExecutionModel {
  const m = file[id];
  if (!m || typeof m !== 'object' || !('executionModel' in m)) {
    throw new Error(`Unknown execution model ${id}`);
  }
  return m;
}

/** Mixing SAME_BAR_CLOSE PnL with NEXT_BAR_OPEN is ENGINE_MISMATCH — never pick the better number. */
export function compareExecutionModels(a: string, b: string): {
  compatible: boolean;
  status: 'PASS' | 'ENGINE_MISMATCH';
  warning: string | null;
  executionModelVersion: string;
} {
  const left = getExecutionModel(a).executionModel;
  const right = getExecutionModel(b).executionModel;
  if (left !== right) {
    return {
      compatible: false,
      status: 'ENGINE_MISMATCH',
      warning: `Cannot compare ${left} results to ${right}. Canonical research fill is NEXT_BAR_OPEN.`,
      executionModelVersion: executionModelVersion(),
    };
  }
  return {
    compatible: true,
    status: 'PASS',
    warning: null,
    executionModelVersion: executionModelVersion(),
  };
}

/** Canonical research fill used for promotion. BacktestEngine SAME_BAR_CLOSE is quarantined. */
export const CANONICAL_PROMOTION_FILL = 'NEXT_BAR_OPEN';

export function isCanonicalPromotionFill(model: string | undefined | null): boolean {
  return model === CANONICAL_PROMOTION_FILL;
}

export const SAME_BAR_PROMOTION_QUARANTINE = {
  promotable: false as const,
  promotionRejection: 'SAME_BAR_CLOSE_NOT_PROMOTABLE' as const,
  comparableToCanonicalResearch: false as const,
  engineMismatchVsNextBarOpen: true as const,
  walkForwardPass: false as const,
};

export function stampSameBarPromotionQuarantine<T extends Record<string, unknown>>(result: T): T & typeof SAME_BAR_PROMOTION_QUARANTINE & { executionModel: string } {
  return {
    ...result,
    ...SAME_BAR_PROMOTION_QUARANTINE,
    executionModel: getExecutionModel('SAME_BAR_CLOSE').executionModel,
  };
}
