import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

export type RejectionCode =
  | 'NO_DATA'
  | 'DATA_QUALITY_FAILED'
  | 'LOOKAHEAD_DETECTED'
  | 'ENGINE_MISMATCH'
  | 'INSUFFICIENT_TRADES'
  | 'INSUFFICIENT_SAMPLE'
  | 'NEGATIVE_EXPECTANCY'
  | 'OOS_FAILED'
  | 'WALK_FORWARD_FAILED'
  | 'PERMUTATION_FAILED'
  | 'MONTE_CARLO_FAILED'
  | 'PARAMETER_FRAGILE'
  | 'COST_FRAGILE'
  | 'REGIME_FRAGILE'
  | 'SYMBOL_FRAGILE'
  | 'MULTIPLE_TESTING_RISK'
  | 'PAPER_INSUFFICIENT'
  | 'PAPER_FAILED'
  | 'CANADIAN_EXECUTION_BLOCKED'
  | 'SYNTHETIC_NOT_PROMOTABLE'
  | 'PROXY_NOT_FEATURE_PARITY'
  | 'UNAVAILABLE';

const file = loadRepoConfigJson<{ codes: string[] }>('researchRejection.json');

export const rejectionCodes: RejectionCode[] = file.codes as RejectionCode[];

export function isRejectionCode(s: string): s is RejectionCode {
  return (file.codes as string[]).includes(s);
}
