/**
 * OpportunityOracle - INDEPENDENT ground truth and scoring for universal-discovery certification (2026-10-14).
 *
 * "Independent" means: it decides what counts as a qualifying opportunity from the GENERATED PRICE/VOLUME DATA with its own fixed, simple rules
 * (no import from any Argus scanner / ranking / strategy module). It then compares Argus's observable discovery outputs against that truth.
 * Pure functions; labeled SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY.
 *
 * Oracle definition of a QUALIFYING moment for a VALID spec (all at minute m, using only bars <= m):
 *   |close/prevClose - 1| >= minMovePct  AND  cumulative dollar volume >= minDollarVolume  AND  RECENT RVOL >= minRvol
 *   (RECENT RVOL = volume of the last 10 minutes / (prevDayVolume/390 * 10): a burst measure owned by the oracle. A mid-day burst barely moves
 *   CUMULATIVE relative volume, so an opportunity is defined by its recent activity, not by the day's running total.)
 * MEAN_REVERSION qualifies on drawdown <= -minReversionDrop from the running high followed by one up-close.
 * A TRAP never qualifies by definition (it is a trap because it fails liquidity / persistence / freshness), and any promotion of a trap
 * is a false positive.
 */
import { SESSION_MINUTES, type HiddenSpec, type SyntheticDiscoveryMarket } from './SyntheticDiscoveryMarket';

export interface OracleRules { minMovePct: number; minDollarVolume: number; minRvol: number; minReversionDrop: number }
export const DEFAULT_ORACLE_RULES: OracleRules = { minMovePct: 0.025, minDollarVolume: 3_000_000, minRvol: 2.5, minReversionDrop: 0.035 };

export interface TruthOpportunity {
  symbol: string;
  kind: string;
  /** minute index the opportunity FIRST satisfied the oracle rules (earliest a perfect observer could act); null = never became observable */
  firstObservableMin: number | null;
  expiryMin: number;
  strength: number;
  insideStartingWatchlist: boolean;
}
export interface TruthTrap { symbol: string; kind: string; startMin: number; endMin: number; insideStartingWatchlist: boolean }

export function buildTruth(market: SyntheticDiscoveryMarket, rules: OracleRules = DEFAULT_ORACLE_RULES): { opportunities: TruthOpportunity[]; traps: TruthTrap[] } {
  const opportunities: TruthOpportunity[] = []; const traps: TruthTrap[] = [];
  for (const spec of market.groundTruth()) {
    if (spec.cls === 'TRAP') { traps.push({ symbol: spec.symbol, kind: spec.kind, startMin: spec.startMin, endMin: spec.startMin + spec.durationMin, insideStartingWatchlist: spec.insideStartingWatchlist }); continue; }
    opportunities.push({ symbol: spec.symbol, kind: spec.kind, firstObservableMin: firstObservable(market, spec, rules), expiryMin: Math.min(SESSION_MINUTES - 1, spec.startMin + spec.durationMin), strength: spec.strength, insideStartingWatchlist: spec.insideStartingWatchlist });
  }
  return { opportunities, traps };
}

function firstObservable(market: SyntheticDiscoveryMarket, spec: HiddenSpec, r: OracleRules): number | null {
  const s = market.barsForOracle(spec.symbol);
  let cumDollar = 0; let runHigh = s.open;
  for (let m = 0; m < SESSION_MINUTES; m++) {
    cumDollar += s.close[m] * s.vol[m]; runHigh = Math.max(runHigh, s.high[m]);
    if (m < spec.startMin) continue;
    if (m > spec.startMin + spec.durationMin) break;
    let recent = 0; for (let k = Math.max(0, m - 9); k <= m; k++) recent += s.vol[k];
    const rvol = recent / ((s.prevVol / SESSION_MINUTES) * Math.min(10, m + 1));
    if (spec.kind === 'MEAN_REVERSION') {
      if (s.close[m] / runHigh - 1 <= -r.minReversionDrop && m > 0 && s.close[m] > s.close[m - 1] && cumDollar >= r.minDollarVolume && rvol >= r.minRvol) return m;
    } else if (Math.abs(s.close[m] / s.prevClose - 1) >= r.minMovePct && cumDollar >= r.minDollarVolume && rvol >= r.minRvol) return m;
  }
  return null;
}

// ---------------- scoring Argus's observable discovery against the truth ----------------

export interface ArgusDiscoveryLog {
  /** minute -> symbols that were in Argus's scan universe at that minute */
  scanned: Map<string, number>;          // symbol -> first minute it was in the scan universe
  /** symbol -> first minute it appeared in the ranked snapshot list (any rank) and its best rank ever */
  ranked: Map<string, { firstMin: number; bestRank: number }>;
  /** symbol -> first minute it was within the top-K of the ranked list, per K */
  topK: Record<number, Map<string, number>>;
  /** symbol -> first minute Argus requested deeper data (WATCHLIST_SUBSCRIBE_REQUESTED) */
  promoted: Map<string, number>;
  /** symbol -> first minute the published top-movers feed (what Argus is given) contained it */
  moversOffered?: Map<string, number>;
}

export type MissClass =
  | 'DISCOVERED_IN_TIME'
  | 'NEVER_BECAME_OBSERVABLE'        // the oracle itself never saw it qualify (generator/rules mismatch) - excluded from recall
  | 'NOT_IN_SCAN_UNIVERSE'           // Argus never even looked at the symbol
  | 'SCANNED_NEVER_RANKED'           // looked at, never produced a ranked candidate
  | 'RANKED_NOT_PROMOTED'            // ranked (possibly high) but never requested deeper data
  | 'OFFERED_BY_MOVERS_NOT_PROMOTED' // the movers feed offered it, it was scanned, but it never won a deeper-data slot
  | 'PROMOTED_AFTER_EXPIRY'          // promoted, but after the opportunity had expired
  | 'PROMOTED_BUT_LATE';             // promoted inside the window but later than the late threshold

export interface OpportunityResult {
  symbol: string; kind: string; insideStartingWatchlist: boolean;
  firstObservableMin: number | null; expiryMin: number;
  scannedMin: number | null; rankedMin: number | null; bestRank: number | null; promotedMin: number | null;
  discoveryLatencyMin: number | null;
  classification: MissClass;
}

export interface DiscoveryScore {
  opportunities: OpportunityResult[];
  eligible: number; discoveredInTime: number; recall: number | null;
  recallInsideWatchlist: number | null; recallOutsideWatchlist: number | null;
  promotedTotal: number; promotedTruePositive: number; promotedTrapHits: number; promotedOther: number; precision: number | null;
  recallAtK: Record<number, number | null>;
  meanReciprocalRank: number | null;
  latencyMin: { p50: number | null; p95: number | null; max: number | null };
  missByClass: Record<string, number>;
}

const q = (xs: number[], p: number): number | null => {
  if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export function scoreDiscovery(
  truth: { opportunities: TruthOpportunity[]; traps: TruthTrap[] }, log: ArgusDiscoveryLog, startingWatchlist: Set<string>,
  opts: { lateAfterMin: number; ks: number[] } = { lateAfterMin: 20, ks: [5, 10, 20] },
): DiscoveryScore {
  const results: OpportunityResult[] = truth.opportunities.map((o) => {
    const scannedMin = log.scanned.get(o.symbol) ?? (startingWatchlist.has(o.symbol) ? 0 : null);
    const r = log.ranked.get(o.symbol);
    const promotedMin = log.promoted.get(o.symbol) ?? null;
    let cls: MissClass;
    if (o.firstObservableMin === null) cls = 'NEVER_BECAME_OBSERVABLE';
    else if (scannedMin === null && promotedMin === null) cls = 'NOT_IN_SCAN_UNIVERSE';
    else if (promotedMin === null) cls = r ? 'RANKED_NOT_PROMOTED' : (log.moversOffered?.has(o.symbol) ? 'OFFERED_BY_MOVERS_NOT_PROMOTED' : 'SCANNED_NEVER_RANKED');
    else if (promotedMin > o.expiryMin) cls = 'PROMOTED_AFTER_EXPIRY';
    else if (promotedMin - o.firstObservableMin > opts.lateAfterMin) cls = 'PROMOTED_BUT_LATE';
    else cls = 'DISCOVERED_IN_TIME';
    return {
      symbol: o.symbol, kind: o.kind, insideStartingWatchlist: o.insideStartingWatchlist, firstObservableMin: o.firstObservableMin, expiryMin: o.expiryMin,
      scannedMin, rankedMin: r?.firstMin ?? null, bestRank: r?.bestRank ?? null, promotedMin,
      discoveryLatencyMin: promotedMin !== null && o.firstObservableMin !== null ? Math.max(0, promotedMin - o.firstObservableMin) : null,
      classification: cls,
    };
  });
  const eligible = results.filter((r) => r.classification !== 'NEVER_BECAME_OBSERVABLE');
  const found = eligible.filter((r) => r.classification === 'DISCOVERED_IN_TIME');
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
  const inside = eligible.filter((r) => r.insideStartingWatchlist); const outside = eligible.filter((r) => !r.insideStartingWatchlist);

  // precision over symbols Argus PROMOTED that were not already in the starting watchlist (a watchlist symbol is not a "discovery")
  const oppBySymbol = new Map(truth.opportunities.map((o) => [o.symbol, o]));
  const trapBySymbol = new Map(truth.traps.map((t) => [t.symbol, t]));
  let tp = 0; let trapHits = 0; let other = 0; let total = 0;
  for (const [sym, minute] of log.promoted) {
    if (startingWatchlist.has(sym)) continue;
    total++;
    const o = oppBySymbol.get(sym); const t = trapBySymbol.get(sym);
    if (o && o.firstObservableMin !== null && minute <= o.expiryMin) tp++;
    else if (t) trapHits++;
    else other++;
  }

  const recallAtK: Record<number, number | null> = {};
  for (const k of opts.ks) {
    const m = log.topK[k];
    recallAtK[k] = ratio(eligible.filter((r) => m?.has(r.symbol) && (m.get(r.symbol)! <= r.expiryMin)).length, eligible.length);
  }
  const rr = eligible.map((r) => (r.bestRank ? 1 / r.bestRank : 0));
  const lat = found.map((r) => r.discoveryLatencyMin!).filter((x) => x !== null);
  const missByClass: Record<string, number> = {};
  for (const r of results) missByClass[r.classification] = (missByClass[r.classification] ?? 0) + 1;
  return {
    opportunities: results, eligible: eligible.length, discoveredInTime: found.length, recall: ratio(found.length, eligible.length),
    recallInsideWatchlist: ratio(inside.filter((r) => r.classification === 'DISCOVERED_IN_TIME').length, inside.length),
    recallOutsideWatchlist: ratio(outside.filter((r) => r.classification === 'DISCOVERED_IN_TIME').length, outside.length),
    promotedTotal: total, promotedTruePositive: tp, promotedTrapHits: trapHits, promotedOther: other, precision: ratio(tp, total),
    recallAtK, meanReciprocalRank: rr.length ? rr.reduce((a, b) => a + b, 0) / rr.length : null,
    latencyMin: { p50: q(lat, 0.5), p95: q(lat, 0.95), max: lat.length ? Math.max(...lat) : null }, missByClass,
  };
}
