/**
 * ==========================================================
 * Module: AgentSynergy
 *
 * Purpose:
 * Phase 3B of FINAL_ANALYSIS.md's 4-phase remediation plan - real Pearson correlation between the
 * actual agents this codebase runs (TechnicalAgent/NewsAgent/FundamentalAgent/MacroAgent/
 * KronosForecastAgent), computed from real agent_predictions rows. Replaces
 * StrategySynergyMatrix.tsx's fabricated matrix, which correlated agent names ("Macro", "Sentiment",
 * "Event", "Geopol") that do not correspond to any real agent in this codebase at all, using a
 * deterministic index-seeded formula, not real data.
 *
 * A "signal value" per prediction is the directionally-signed confidence: +confidence for BUY,
 * -confidence for SELL, 0 for HOLD (including the real DATA_UNAVAILABLE HOLD/confidence:0 shape
 * Fundamental/MacroAgent emit). Two agents' signal series are aligned by (symbol, calendar day) -
 * only days both agents actually predicted on the same symbol contribute to the correlation, and a
 * pair with too few overlapping days reports null (never a fabricated coefficient from thin data).
 * ==========================================================
 */

export const REAL_AGENT_NAMES = ['TechnicalAgent', 'NewsAgent', 'FundamentalAgent', 'MacroAgent', 'KronosForecastAgent'] as const;
export type RealAgentName = typeof REAL_AGENT_NAMES[number];

// Real inter-agent overlap is naturally much sparser than daily price history (agents don't
// predict on every symbol every day) - a smaller floor than PositionSizing's 20-day price-history
// requirement is honest here, not a double standard; below this, null is reported instead.
export const MIN_OVERLAPPING_DAYS = 5;

export interface AgentPredictionRow {
  agentName: string;
  symbol: string;
  prediction: string; // 'BUY' | 'SELL' | 'HOLD'
  confidence: number;
  timestamp: string; // ISO
}

export function signalValue(prediction: string, confidence: number): number {
  if (prediction === 'BUY') return confidence;
  if (prediction === 'SELL') return -confidence;
  return 0; // HOLD, including DATA_UNAVAILABLE - a real, meaningful zero, not missing data
}

/** General Pearson correlation of two paired value series (not returns - the levels themselves). */
export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    cov += dx * dy; varX += dx * dx; varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

export interface SynergyResult {
  agents: readonly string[];
  matrix: (number | null)[][];
  sampleCounts: number[][];
}

/**
 * Real agent-synergy correlation matrix from real predictions. `predictions` should be pre-
 * filtered by the caller to a relevant real window (e.g. the last 30 days) - this function itself
 * does no time filtering, just aggregation and correlation.
 */
export function computeAgentSynergyMatrix(predictions: AgentPredictionRow[], minOverlappingDays = MIN_OVERLAPPING_DAYS): SynergyResult {
  const agents = REAL_AGENT_NAMES;
  const perAgentDaily: Record<string, Map<string, number[]>> = {};
  for (const agent of agents) perAgentDaily[agent] = new Map();

  for (const p of predictions) {
    if (!(agents as readonly string[]).includes(p.agentName)) continue;
    const day = p.timestamp.slice(0, 10);
    const key = `${p.symbol}:${day}`;
    const val = signalValue(p.prediction, p.confidence);
    const arr = perAgentDaily[p.agentName].get(key) ?? [];
    arr.push(val);
    perAgentDaily[p.agentName].set(key, arr);
  }

  // Average multiple same-day/same-symbol predictions from one agent into a single daily value.
  const perAgentAvg: Record<string, Map<string, number>> = {};
  for (const agent of agents) {
    perAgentAvg[agent] = new Map();
    for (const [key, arr] of perAgentDaily[agent]) {
      perAgentAvg[agent].set(key, arr.reduce((a, b) => a + b, 0) / arr.length);
    }
  }

  const matrix: (number | null)[][] = [];
  const sampleCounts: number[][] = [];
  for (let i = 0; i < agents.length; i++) {
    const row: (number | null)[] = [];
    const rowCounts: number[] = [];
    for (let j = 0; j < agents.length; j++) {
      if (i === j) {
        row.push(1);
        rowCounts.push(perAgentAvg[agents[i]].size);
        continue;
      }
      const seriesA = perAgentAvg[agents[i]];
      const seriesB = perAgentAvg[agents[j]];
      const commonKeys = [...seriesA.keys()].filter(k => seriesB.has(k));
      rowCounts.push(commonKeys.length);
      if (commonKeys.length < minOverlappingDays) {
        row.push(null);
        continue;
      }
      const xs = commonKeys.map(k => seriesA.get(k)!);
      const ys = commonKeys.map(k => seriesB.get(k)!);
      row.push(pearsonCorrelation(xs, ys));
    }
    matrix.push(row);
    sampleCounts.push(rowCounts);
  }

  return { agents, matrix, sampleCounts };
}
