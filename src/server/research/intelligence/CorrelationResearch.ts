/**
 * Correlation & Diversification (Phase 10). Reuses the existing, live-gate-backing Pearson
 * daily-return correlation (`returnCorrelation`, PositionSizing.ts) — the same function RiskEngine
 * gate #20 (correlation_exposure) already relies on. This module does NOT reimplement correlation
 * math; it only adds a portfolio-level view (pairwise matrix, threshold clusters, a diversification
 * score) that nothing in the live path currently needs, and nothing here writes back to
 * PositionSizing or RiskEngine.
 */
import { returnCorrelation } from '../../engines/PositionSizing';
import { tradingSafety } from '../../config/tradingSafety';
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export interface CorrelationPair {
  symbolA: string;
  symbolB: string;
  correlation: number | null;
}

export interface CorrelationCluster {
  symbols: string[];
  averageIntraClusterCorrelation: number;
}

export interface CorrelationAnalysis {
  pairs: CorrelationPair[];
  clusters: CorrelationCluster[];
  /** 1 - mean |correlation| across all computable pairs. Higher = more diversified. Null if <2 computable pairs. */
  diversificationScore: number | null;
  /** Same threshold RiskEngine gate #20 already uses (tradingSafety.correlationThreshold) — reused, not redefined. */
  clusterThreshold: number;
}

/** Union-find over the correlationThreshold graph — no new clustering algorithm invented, just grouping. */
function clusterByThreshold(symbols: string[], pairs: CorrelationPair[], threshold: number): CorrelationCluster[] {
  const parent = new Map(symbols.map((s) => [s, s]));
  function find(s: string): string {
    while (parent.get(s) !== s) {
      parent.set(s, parent.get(parent.get(s)!)!);
      s = parent.get(s)!;
    }
    return s;
  }
  function union(a: string, b: string) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const p of pairs) {
    if (p.correlation !== null && Math.abs(p.correlation) >= threshold) union(p.symbolA, p.symbolB);
  }
  const groups = new Map<string, string[]>();
  for (const s of symbols) {
    const root = find(s);
    const g = groups.get(root) ?? [];
    g.push(s);
    groups.set(root, g);
  }
  const clusters: CorrelationCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const memberPairs = pairs.filter((p) => members.includes(p.symbolA) && members.includes(p.symbolB) && p.correlation !== null);
    const avg = memberPairs.length
      ? memberPairs.reduce((s, p) => s + Math.abs(p.correlation as number), 0) / memberPairs.length
      : 0;
    clusters.push({ symbols: members, averageIntraClusterCorrelation: avg });
  }
  return clusters;
}

export function runCorrelationResearch(opts: {
  /** symbol -> closing-price series (same shape returnCorrelation already expects). */
  closesBySymbol: Record<string, number[]>;
  traceId?: string;
}): ResearchResult<CorrelationAnalysis> {
  const symbols = Object.keys(opts.closesBySymbol);
  const pairs: CorrelationPair[] = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const symbolA = symbols[i], symbolB = symbols[j];
      const correlation = returnCorrelation(opts.closesBySymbol[symbolA], opts.closesBySymbol[symbolB]);
      pairs.push({ symbolA, symbolB, correlation });
    }
  }
  const computable = pairs.filter((p) => p.correlation !== null);
  const diversificationScore = computable.length
    ? 1 - computable.reduce((s, p) => s + Math.abs(p.correlation as number), 0) / computable.length
    : null;
  const clusterThreshold = tradingSafety.correlationThreshold;
  const clusters = clusterByThreshold(symbols, pairs, clusterThreshold);

  const dataQuality: DataQualityMeta = {
    source: 'PositionSizing.returnCorrelation (reused)',
    timestamp: new Date().toISOString(),
    sampleSize: symbols.length,
    missingFields: pairs.filter((p) => p.correlation === null).map((p) => `${p.symbolA}-${p.symbolB}: insufficient overlap`),
    staleness: 'FRESH',
    assumptions: [`Correlation computed on daily returns; cluster threshold reused from tradingSafety.correlationThreshold (${clusterThreshold}), not redefined here.`],
    quality: computable.length === pairs.length && pairs.length > 0 ? 'GREEN' : computable.length > 0 ? 'YELLOW' : 'UNAVAILABLE',
  };

  const analysis: CorrelationAnalysis = { pairs, clusters, diversificationScore, clusterThreshold };
  const result = wrapResearchResult({ capability: 'CORRELATION_DIVERSIFICATION', label: 'RESEARCH', dataQuality, data: analysis });
  emitResearchEvent('CORRELATION_ANALYSIS_COMPLETED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbolCount: symbols.length,
    clusterCount: clusters.length,
    diversificationScore,
  });
  return result;
}
