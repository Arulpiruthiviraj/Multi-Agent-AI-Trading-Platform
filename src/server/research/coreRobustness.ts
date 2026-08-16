/**
 * CORE robustness on canonical NEXT_BAR fills. Does not retune to pass.
 */
import type { ResearchBar } from './ohlcvTypes';
import { applyNextBarLongFills, loadCanonicalCosts, metricsFromClosedTrades, type CanonicalFillCosts } from './canonicalNextBarEngine';
import { researchSafety } from '../config/researchSafety';
import type { ArgusReplaySignal } from './argusStrategyReplay';

export type RobustnessLabel = 'ROBUST' | 'FRAGILE' | 'FAILED' | 'INSUFFICIENT_SAMPLE';

export interface CoreRobustnessReport {
  label: RobustnessLabel;
  centerNetPnl: number | null;
  perturbations: Array<{ name: string; netPnl: number | null; tradeCount: number }>;
  note: string;
}

function withCosts(over: Partial<CanonicalFillCosts>): CanonicalFillCosts {
  return { ...loadCanonicalCosts(), ...over };
}

export function runCoreRobustness(
  bars: ResearchBar[],
  signals: Array<Pick<ArgusReplaySignal, 'barIndex' | 'side' | 'stop' | 'target'>>,
): CoreRobustnessReport {
  const center = applyNextBarLongFills(bars, signals, loadCanonicalCosts());
  const centerM = metricsFromClosedTrades(center.trades, researchSafety.minOosTrades);
  if (centerM.tradeCount === 0) {
    return {
      label: 'INSUFFICIENT_SAMPLE',
      centerNetPnl: null,
      perturbations: [],
      note: 'No closed NEXT_BAR trades. Not ROBUST. Not an edge.',
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

  return {
    label,
    centerNetPnl: centerM.netPnl,
    perturbations,
    note: 'Adversarial perturbation of NEXT_BAR fills. Not optimized to pass. Zero-cost center still cannot promote.',
  };
}
