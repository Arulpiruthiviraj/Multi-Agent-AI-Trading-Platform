/**
 * Effective-N autocorrelation clustering + Wilson score interval.
 *
 * ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md (2026-08-20) found that raw prediction/outcome row
 * counts massively overstate real sample size for tick-driven agents (TechnicalAgent) and
 * agents that re-fire on an unchanged market condition (Kronos) - raw N inflated the apparent
 * precision of accuracy statistics by 21x-770x in that audit. A prediction less than one
 * evaluation-horizon apart from the prior same-agent/same-symbol/same-direction prediction is not
 * an independent observation - it shares an overlapping outcome window with it.
 *
 * This module is deliberately conservative: it groups by (symbol, agent, side) with a time-gap
 * threshold and reports the resulting group count as "effective N" - a real, defensible lower
 * bound on independent observations, not a fabricated statistical estimator. Never claim precision
 * beyond what this clustering actually supports.
 */

export interface ClusterableRow {
  symbol: string;
  agent: string;
  side: string;
  timestampMs: number;
  outcome: 'WIN' | 'LOSS' | 'N_A';
  /**
   * Optional agent-specific sub-identity (predictionIndependencePolicy.ts's secondaryGroupKey) -
   * e.g. QuantEngine's strategy id, or 'COLD_START_BOOTSTRAP' - so two structurally different
   * signal sources for the same (symbol, agent, side) are never pooled into one cluster series.
   * Rows without one (the default (symbol, agent, side) grouping) pass undefined.
   */
  secondaryKey?: string;
}

export interface ClusteredGroup {
  symbol: string;
  agent: string;
  side: string;
  rows: ClusterableRow[];
  /** WIN/LOSS-only outcome of the group's own last row - one independent observation per group. */
  outcome: 'WIN' | 'LOSS' | 'N_A';
}

/**
 * Groups rows by (symbol, agent, side[, secondaryKey]), then splits each group into clusters
 * wherever the gap between consecutive (time-sorted) rows exceeds gapMs. Each cluster counts as
 * exactly one effectively-independent observation, graded by its last row's outcome (the most
 * information a single cluster can contribute without double-counting the repeated observations
 * inside it).
 */
export function clusterByTimeGap(rows: ClusterableRow[], gapMs: number): ClusteredGroup[] {
  const bySeries = new Map<string, ClusterableRow[]>();
  for (const row of rows) {
    const key = `${row.symbol}|${row.agent}|${row.side}|${row.secondaryKey ?? ''}`;
    const list = bySeries.get(key) ?? [];
    list.push(row);
    bySeries.set(key, list);
  }

  const clusters: ClusteredGroup[] = [];
  for (const [key, seriesRows] of bySeries) {
    const [symbol, agent, side] = key.split('|');
    const sorted = [...seriesRows].sort((a, b) => a.timestampMs - b.timestampMs);
    let current: ClusterableRow[] = [];
    for (const row of sorted) {
      if (current.length > 0 && row.timestampMs - current[current.length - 1].timestampMs > gapMs) {
        clusters.push({ symbol, agent, side, rows: current, outcome: current[current.length - 1].outcome });
        current = [];
      }
      current.push(row);
    }
    if (current.length > 0) {
      clusters.push({ symbol, agent, side, rows: current, outcome: current[current.length - 1].outcome });
    }
  }
  return clusters;
}

/**
 * Per-row independence tag (Phase 3's RAW/EVALUATED/CORRELATED/INDEPENDENT taxonomy): the last
 * (most recent) row in each time-gap cluster is the one INDEPENDENT observation counted toward
 * effective N; every earlier row in the same cluster is CORRELATED - a real evaluated outcome,
 * never hidden or deleted, just not double-counted as separate evidence.
 */
export function tagRowIndependence(rows: ClusterableRow[], gapMs: number): Map<ClusterableRow, 'INDEPENDENT' | 'CORRELATED'> {
  const tags = new Map<ClusterableRow, 'INDEPENDENT' | 'CORRELATED'>();
  for (const cluster of clusterByTimeGap(rows, gapMs)) {
    const last = cluster.rows[cluster.rows.length - 1];
    for (const row of cluster.rows) {
      tags.set(row, row === last ? 'INDEPENDENT' : 'CORRELATED');
    }
  }
  return tags;
}

export type EvidenceStatus = 'INSUFFICIENT_EVIDENCE' | 'LEARNING_ELIGIBLE';

/**
 * Whether an agent's EFFECTIVE (not raw) sample size clears the configured trust floor. Applying
 * the same floor to effective rather than raw N is strictly more conservative (effectiveN <=
 * rawN always) - fewer agents will read LEARNING_ELIGIBLE than under the old raw-N gate, never
 * more. Never returns anything claiming edge; this only gates whether there is enough independent
 * evidence to trust a computed statistic at all.
 */
export function classifyEvidenceStatus(effectiveN: number, minEffectiveSampleSize: number): EvidenceStatus {
  return effectiveN >= minEffectiveSampleSize ? 'LEARNING_ELIGIBLE' : 'INSUFFICIENT_EVIDENCE';
}

export interface WilsonInterval {
  n: number;
  wins: number;
  pointEstimate: number | null;
  lower: number | null;
  upper: number | null;
}

/** 95% Wilson score interval (z=1.96) for a binomial win rate. Returns nulls for n=0. */
export function wilsonInterval(wins: number, n: number, z = 1.96): WilsonInterval {
  if (n <= 0) return { n, wins, pointEstimate: null, lower: null, upper: null };
  const phat = wins / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denominator;
  return {
    n,
    wins,
    pointEstimate: phat,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

export interface RawVsEffective {
  rawN: number;
  rawWins: number;
  rawInterval: WilsonInterval;
  effectiveN: number;
  effectiveWins: number;
  effectiveInterval: WilsonInterval;
  inflationFactor: number | null;
}

/**
 * Directional (WIN/LOSS only, N_A excluded) raw-vs-effective comparison for one population of
 * rows already filtered to a single agent/confidence-bucket/etc. Reports both so a caller never
 * has to choose - and never silently overwrites raw counts with the clustered ones.
 */
export function rawVsEffectiveDirectional(rows: ClusterableRow[], clusterGapMs: number): RawVsEffective {
  const directional = rows.filter((r) => r.outcome !== 'N_A');
  const rawN = directional.length;
  const rawWins = directional.filter((r) => r.outcome === 'WIN').length;

  const clusters = clusterByTimeGap(directional, clusterGapMs).filter((c) => c.outcome !== 'N_A');
  const effectiveN = clusters.length;
  const effectiveWins = clusters.filter((c) => c.outcome === 'WIN').length;

  return {
    rawN,
    rawWins,
    rawInterval: wilsonInterval(rawWins, rawN),
    effectiveN,
    effectiveWins,
    effectiveInterval: wilsonInterval(effectiveWins, effectiveN),
    inflationFactor: effectiveN > 0 ? rawN / effectiveN : null,
  };
}
