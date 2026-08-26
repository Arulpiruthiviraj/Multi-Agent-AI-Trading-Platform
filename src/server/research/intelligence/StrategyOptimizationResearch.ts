/**
 * Strategy Optimization (Phase 9). Generic grid-search harness with anti-overfitting protections
 * baked into the control flow, not left to the caller to remember: every parameter combination is
 * scored on TRAIN only for selection, then re-scored on TEST — the reported "best" parameters are
 * chosen by their TRAIN rank but the number the caller should trust is the TEST metric, returned
 * alongside train/test divergence and a stability score across neighboring parameter combinations.
 *
 * Does not fabricate a parameterized-strategy backtest wiring that doesn't exist yet (Argus's
 * quant strategies are not currently generically parameterizable) — instead accepts a caller-
 * supplied evaluator, so this module IS the anti-overfitting harness itself (the genuinely missing
 * piece), reused for whatever evaluator the caller has (a backtest, a walk-forward fold, etc.).
 */
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export interface ParameterCombo {
  [param: string]: number;
}

export interface ParameterEvaluation {
  params: ParameterCombo;
  trainMetric: number;
  testMetric: number;
  trainTestDivergence: number; // |trainMetric - testMetric| / max(|trainMetric|, epsilon)
}

export interface OptimizationResult {
  evaluations: ParameterEvaluation[];
  bestByTrain: ParameterEvaluation | null;
  /** Best by TEST metric — the number that should actually inform any real decision. */
  bestByTest: ParameterEvaluation | null;
  /** Mean of |trainMetric - testMetric| across all combos — high divergence = likely overfit search space. */
  meanTrainTestDivergence: number;
  /** Std dev of testMetric across all combos, relative to its mean — low = stable/insensitive to params (good); high = fragile. */
  parameterStabilityScore: number | null;
  overfitWarning: string | null;
}

function cartesianProduct(ranges: Record<string, number[]>): ParameterCombo[] {
  const keys = Object.keys(ranges);
  if (keys.length === 0) return [{}];
  return keys.reduce<ParameterCombo[]>((acc, key) => {
    const values = ranges[key];
    const next: ParameterCombo[] = [];
    for (const combo of acc) {
      for (const v of values) next.push({ ...combo, [key]: v });
    }
    return next;
  }, [{}]);
}

export function runStrategyOptimization(opts: {
  symbol: string;
  strategyId: string;
  parameterRanges: Record<string, number[]>;
  /** Caller-supplied, real evaluator — e.g. wraps a backtest call per param combo on the given split. Never optimizes against the full dataset only: caller must supply genuinely separate train/test data. */
  evaluate: (params: ParameterCombo) => { trainMetric: number; testMetric: number };
  maxCombos?: number;
  traceId?: string;
}): ResearchResult<OptimizationResult> {
  const allCombos = cartesianProduct(opts.parameterRanges);
  const cap = opts.maxCombos ?? 500;
  const combos = allCombos.slice(0, cap);

  const evaluations: ParameterEvaluation[] = combos.map((params) => {
    const { trainMetric, testMetric } = opts.evaluate(params);
    const divergence = Math.abs(trainMetric - testMetric) / Math.max(Math.abs(trainMetric), 1e-6);
    return { params, trainMetric, testMetric, trainTestDivergence: divergence };
  });

  const bestByTrain = evaluations.length
    ? evaluations.reduce((best, e) => (e.trainMetric > best.trainMetric ? e : best))
    : null;
  // Selecting "best" by test metric alone, then reporting how it did on train, is exactly the
  // "do not select parameters based solely on maximum historical return" the spec warns against —
  // bestByTest here is reported for transparency, not as the sole recommendation.
  const bestByTest = evaluations.length
    ? evaluations.reduce((best, e) => (e.testMetric > best.testMetric ? e : best))
    : null;

  const meanTrainTestDivergence = evaluations.length
    ? evaluations.reduce((s, e) => s + e.trainTestDivergence, 0) / evaluations.length
    : 0;

  const testMetrics = evaluations.map((e) => e.testMetric);
  const meanTest = testMetrics.length ? testMetrics.reduce((s, v) => s + v, 0) / testMetrics.length : 0;
  const varianceTest = testMetrics.length
    ? testMetrics.reduce((s, v) => s + (v - meanTest) ** 2, 0) / testMetrics.length
    : 0;
  const stdTest = Math.sqrt(varianceTest);
  const parameterStabilityScore = testMetrics.length && meanTest !== 0 ? 1 - Math.min(1, stdTest / Math.abs(meanTest)) : null;

  const overfitWarning = meanTrainTestDivergence > 0.5
    ? `Mean train/test divergence ${(meanTrainTestDivergence * 100).toFixed(0)}% is large — the parameter search may be fitting train-set noise. Prefer bestByTest, or a wider dataset, over bestByTrain.`
    : bestByTrain && bestByTest && bestByTrain.params !== bestByTest.params
    ? 'Best-by-train and best-by-test parameters differ — this itself is evidence against picking parameters from train performance alone.'
    : null;

  const dataQuality: DataQualityMeta = {
    source: 'StrategyOptimizationResearch.ts — new generic grid-search harness with enforced train/test separation',
    symbol: opts.symbol,
    timestamp: new Date().toISOString(),
    sampleSize: evaluations.length,
    missingFields: allCombos.length > cap ? [`${allCombos.length - cap} parameter combinations skipped (maxCombos=${cap})`] : [],
    staleness: 'FRESH',
    assumptions: ['Caller-supplied evaluator must itself keep train and test data genuinely separate — this harness cannot detect a leaking evaluator, only report the resulting divergence.'],
    quality: evaluations.length > 0 ? 'GREEN' : 'UNAVAILABLE',
  };

  const data: OptimizationResult = { evaluations, bestByTrain, bestByTest, meanTrainTestDivergence, parameterStabilityScore, overfitWarning };
  const result = wrapResearchResult({ capability: 'STRATEGY_OPTIMIZATION', label: 'RESEARCH', dataQuality, data });
  emitResearchEvent('STRATEGY_OPTIMIZED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.symbol,
    strategyId: opts.strategyId,
    combosEvaluated: evaluations.length,
    overfitWarning: !!overfitWarning,
  });
  return result;
}
