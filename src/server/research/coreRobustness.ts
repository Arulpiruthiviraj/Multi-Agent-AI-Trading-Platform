/**
 * CORE robustness on canonical NEXT_BAR fills. Does not retune to pass.
 * Emits evidence-ready gates for promotion (never auto LIVE_CANDIDATE).
 */
import type { ResearchBar } from './ohlcvTypes';
import { applyNextBarLongFills, loadCanonicalCosts, metricsFromClosedTrades, type CanonicalFillCosts } from './canonicalNextBarEngine';
import { researchSafety } from '../config/researchSafety';
import type { ArgusReplaySignal } from './argusStrategyReplay';
import { permutationTestPnls } from './robustness';
import { runMonteCarlo } from '../quant/analysis/MonteCarlo';
import type { StrategyEvidence } from './promotionEngine';

export type RobustnessLabel = 'ROBUST' | 'FRAGILE' | 'FAILED' | 'INSUFFICIENT_SAMPLE';

export interface CoreRobustnessReport {
  label: RobustnessLabel;
  centerNetPnl: number | null;
  perturbations: Array<{ name: string; netPnl: number | null; tradeCount: number }>;
  note: string;
  /** Evidence gates for promotionEngine — all false when sample insufficient. */
  gates: {
    monteCarloPass: boolean;
    permutationPass: boolean;
    sensitivityPass: boolean;
    costStressPass: boolean;
  };
  permutation: { pValue: number | null; pass: boolean; sampleSize: number };
  monteCarlo: { ruinProbability: number | null; pass: boolean; sampleSize: number };
}

function withCosts(over: Partial<CanonicalFillCosts>): CanonicalFillCosts {
  return { ...loadCanonicalCosts(), ...over };
}

const emptyGates = () => ({
  monteCarloPass: false,
  permutationPass: false,
  sensitivityPass: false,
  costStressPass: false,
});

export function runCoreRobustness(
  bars: ResearchBar[],
  signals: Array<Pick<ArgusReplaySignal, 'barIndex' | 'side' | 'stop' | 'target'>>,
): CoreRobustnessReport {
  const center = applyNextBarLongFills(bars, signals, loadCanonicalCosts());
  const centerM = metricsFromClosedTrades(center.trades, researchSafety.minOosTrades);
  const closedPnls = center.trades.filter((t) => t.pnl != null).map((t) => t.pnl as number);

  if (centerM.tradeCount === 0) {
    return {
      label: 'INSUFFICIENT_SAMPLE',
      centerNetPnl: null,
      perturbations: [],
      note: 'No closed NEXT_BAR trades. Not ROBUST. Not an edge.',
      gates: emptyGates(),
      permutation: { pValue: null, pass: false, sampleSize: 0 },
      monteCarlo: { ruinProbability: null, pass: false, sampleSize: 0 },
    };
  }

  const delayed = signals.map((s) => ({ ...s, barIndex: s.barIndex + 1 })).filter((s) => s.barIndex < bars.length - 1);
  const omitted = signals.filter((_, i) => i % 3 !== 0);
  const cases: Array<{ name: string; costs: CanonicalFillCosts; sigs: typeof signals }> = [
    { name: 'center', costs: loadCanonicalCosts(), sigs: signals },
    { name: 'cost_x2', costs: withCosts({ commissionPerShare: researchSafety.commissionPerShare * 2 || 0.01 }), sigs: signals },
    { name: 'slippage_x2', costs: withCosts({ slippageBps: Math.max(researchSafety.slippageBps * 2, 5) }), sigs: signals },
    { name: 'spread_x2', costs: withCosts({ spreadBps: Math.max(researchSafety.spreadBps * 2, 5) }), sigs: signals },
    { name: 'entry_delay_1bar', costs: loadCanonicalCosts(), sigs: delayed },
    { name: 'omit_every_third_signal', costs: loadCanonicalCosts(), sigs: omitted },
  ];

  const perturbations = cases.map((c) => {
    const r = applyNextBarLongFills(bars, c.sigs, c.costs);
    const m = metricsFromClosedTrades(r.trades, researchSafety.minOosTrades);
    return { name: c.name, netPnl: m.netPnl, tradeCount: m.tradeCount };
  });
  const others = perturbations.filter((p) => p.name !== 'center');
  const centerPnl = centerM.netPnl ?? 0;
  const anyOtherPositive = others.some((p) => (p.netPnl ?? 0) > 0);
  let label: RobustnessLabel = 'FAILED';
  if (centerM.tradeCount < researchSafety.minOosTrades) label = 'INSUFFICIENT_SAMPLE';
  else if (centerPnl <= 0) label = 'FAILED';
  else if (!anyOtherPositive) label = 'FRAGILE';
  else label = 'ROBUST';

  const costCases = perturbations.filter((p) => p.name.startsWith('cost_') || p.name.startsWith('slippage_') || p.name.startsWith('spread_'));
  const costStressPass =
    centerPnl > 0 &&
    costCases.length > 0 &&
    costCases.every((p) => (p.netPnl ?? Number.NEGATIVE_INFINITY) > centerPnl * -researchSafety.costStressMaxMultipleStillProfitable);

  const sensitivityPass =
    label === 'ROBUST' ||
    (centerPnl > 0 && perturbations.some((p) => p.name === 'entry_delay_1bar' && (p.netPnl ?? 0) > 0));

  const perm = permutationTestPnls(closedPnls);
  const permutationPass = closedPnls.length >= researchSafety.minOosTrades && perm.pass;

  let monteCarloPass = false;
  let ruinProbability: number | null = null;
  if (closedPnls.length >= researchSafety.minOosTrades) {
    const meanAbs = closedPnls.reduce((s, v) => s + Math.abs(v), 0) / closedPnls.length || 1;
    const rMultiples = closedPnls.map((p) => p / meanAbs);
    const mc = runMonteCarlo({
      rMultiples,
      initialCapital: researchSafety.goldenInitialCapital,
      riskPerTradePct: 0.01,
      pathLength: Math.min(100, Math.max(20, closedPnls.length * 2)),
      simulations: 500,
    });
    ruinProbability = mc.probabilityOfLoss;
    // Pass only when statistically justified AND loss probability is not catastrophic — never invent edge.
    monteCarloPass = mc.statisticallyJustified === true && typeof ruinProbability === 'number' && ruinProbability < 0.5;
  }

  return {
    label,
    centerNetPnl: centerM.netPnl,
    perturbations,
    note: 'Adversarial perturbation + permutation + Monte Carlo on NEXT_BAR fills. Not optimized to pass. Zero-cost center still cannot promote.',
    gates: {
      monteCarloPass,
      permutationPass,
      sensitivityPass,
      costStressPass,
    },
    permutation: { pValue: perm.pValue, pass: permutationPass, sampleSize: closedPnls.length },
    monteCarlo: { ruinProbability, pass: monteCarloPass, sampleSize: closedPnls.length },
  };
}

/** Merge robustness gates into promotion evidence (never sets LIVE_* by itself). */
export function applyRobustnessGates(e: StrategyEvidence, report: CoreRobustnessReport): StrategyEvidence {
  return {
    ...e,
    monteCarloPass: report.gates.monteCarloPass,
    permutationPass: report.gates.permutationPass,
    sensitivityPass: report.gates.sensitivityPass,
    costStressPass: report.gates.costStressPass,
  };
}
