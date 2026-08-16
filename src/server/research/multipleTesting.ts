import { researchSafety } from '../config/researchSafety';

export function multipleTestingWarning(trials: number): { warning: boolean; trials: number; note: string } {
  const warning = trials > researchSafety.multipleTestingWarnAboveTrials;
  return {
    warning,
    trials,
    note: warning
      ? `MULTIPLE_TESTING_RISK: ${trials} trials exceed researchSafety.multipleTestingWarnAboveTrials. Best-of-search is not an edge.`
      : `trials=${trials}`,
  };
}
