/**
 * Phase 14 (2026-08-31 historical-replay & fair-exploration mission), Objectives 4/6: the
 * orchestration layer this mission's forensic investigation found missing - FullArgusReplayEngine.ts
 * already reuses the real production StrategyEngine/RiskEngine/regime classification/execution
 * model for one replay window; nothing previously chained multiple chronological windows into a
 * walk-forward verdict. This module adds exactly that chaining, reusing:
 *   - FullArgusReplayEngine.ts's real createReplayRun()/getReplayTrades() (never a second,
 *     simplified strategy or execution implementation)
 *   - effectiveSampleSize.ts's real wilsonInterval() (the same statistic organic evidence uses)
 *
 * Anti-lookahead: each fold is a fully independent createReplayRun() call over its own
 * [fromDate, toDate) window - InformationCutoff.ts (already exercised by the existing replay test
 * suite - historicalReplay.test.ts, pitProviders.test.ts, phase18/24 full-replay tests) enforces
 * that no bar/news/fundamental data beyond each simulated timestamp is ever visible within a run.
 * This module does not and cannot introduce lookahead across folds either: later folds are never
 * consulted while computing an earlier fold's own result - each fold's statistic depends only on
 * its own window's real trades.
 *
 * Isolation (Objective 9): every trade this module reads comes from getReplayTrades(), which is
 * fully separate storage from the live `trades` SQL table (confirmed: HISTORICAL_REPLAY-tagged,
 * never written to the organic ledger at all) - this module cannot pollute organic evidence
 * because it never writes to organic tables; it only reads replay's own isolated trade ledger.
 */
import { createReplayRun, getReplayTrades } from '../replay/FullArgusReplayEngine';
import { wilsonInterval } from './effectiveSampleSize';

export interface ReplayTradeRow {
  timestamp: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  strategyId: string;
  traceId: string;
  fees?: number;
  slippage?: number;
  realizedPnl: number | null;
  executionEnvironment: string;
}

export interface ReplayFoldResult {
  foldIndex: number;
  fromDate: string;
  toDate: string;
  replayId: string;
  status: string;
  error?: string;
  /** Real per-strategy stats from this fold's own isolated replay run only. */
  strategyStats: Record<string, { closedTrades: number; wins: number; losses: number; netPnl: number }>;
}

export interface ReplayWalkForwardConfig {
  symbols: string[];
  strategyIds: string[];
  startDate: string;
  endDate: string;
  foldCount: number;
  costProfile?: string;
  initialCapital?: number;
  frequency?: string;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayCount(fromIso: string, toIso: string): number {
  const from = new Date(fromIso + 'T00:00:00.000Z').getTime();
  const to = new Date(toIso + 'T00:00:00.000Z').getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/** Runs `foldCount` real, chronologically sequential, non-overlapping replay windows spanning
 *  [startDate, endDate) - each an independent createReplayRun() call - and summarizes each fold's
 *  own real (HISTORICAL_REPLAY-tagged) closed trades per strategy. Never blends folds together;
 *  callers apply their own cross-fold consistency judgment (see summarizeWalkForwardConsistency). */
export async function runReplayWalkForward(config: ReplayWalkForwardConfig): Promise<ReplayFoldResult[]> {
  const totalDays = dayCount(config.startDate, config.endDate);
  const foldDays = Math.floor(totalDays / config.foldCount);
  const results: ReplayFoldResult[] = [];

  for (let i = 0; i < config.foldCount; i++) {
    const fromDate = addDaysIso(config.startDate, i * foldDays);
    const toDate = i === config.foldCount - 1 ? config.endDate : addDaysIso(config.startDate, (i + 1) * foldDays);

    const run = await createReplayRun({
      startDate: fromDate,
      endDate: toDate,
      universeSource: 'OPERATOR_SELECTED',
      symbols: config.symbols,
      frequency: config.frequency ?? '1Day',
      dataProvider: 'alpaca',
      aiMode: 'DISABLED',
      strategyIds: config.strategyIds,
      initialCapital: config.initialCapital ?? 2000,
      costProfile: config.costProfile,
      speed: 'MAX',
    } as any);

    const replayId = String((run as any).replayId);
    const status = String((run as any).status);
    const strategyStats: ReplayFoldResult['strategyStats'] = {};

    if (status === 'COMPLETED' || status === 'PARTIAL') {
      const trades = (getReplayTrades(replayId) as ReplayTradeRow[] | null) ?? [];
      for (const t of trades) {
        if (t.side !== 'SELL' || t.realizedPnl === null) continue; // only closed round-trips carry realizedPnl
        const key = t.strategyId || 'UNKNOWN';
        if (!strategyStats[key]) strategyStats[key] = { closedTrades: 0, wins: 0, losses: 0, netPnl: 0 };
        strategyStats[key].closedTrades += 1;
        strategyStats[key].netPnl += t.realizedPnl;
        if (t.realizedPnl > 0) strategyStats[key].wins += 1;
        else strategyStats[key].losses += 1;
      }
    }

    results.push({
      foldIndex: i,
      fromDate,
      toDate,
      replayId,
      status,
      error: (run as any).error,
      strategyStats,
    });
  }

  return results;
}

export interface StrategyWalkForwardVerdict {
  strategyId: string;
  totalClosedTrades: number;
  totalNetPnl: number;
  foldsWithEvidence: number;
  foldsAboveChance: number;
  foldsBelowChance: number;
  status: 'NO_EVIDENCE' | 'INSUFFICIENT_SAMPLE' | 'CONSISTENT_ABOVE_CHANCE' | 'CONSISTENT_BELOW_CHANCE' | 'INCONSISTENT';
  reason: string;
}

/** Cross-fold consistency judgment over runReplayWalkForward()'s own real per-fold results - the
 *  same "does every judgeable fold agree on which side of chance it sits" logic
 *  chronologicalEdgeValidation.ts already uses for organic evidence, reused here (not duplicated:
 *  wilsonInterval is the same import) for REPLAY evidence, which is explicitly never merged with
 *  organic evidence anywhere in this module. */
export function summarizeWalkForwardConsistency(
  folds: ReplayFoldResult[],
  minTradesPerFold: number = 5,
  requestedStrategyIds: string[] = [],
): StrategyWalkForwardVerdict[] {
  // A strategy that produced zero real closed trades in every fold never appears as a key in any
  // fold's strategyStats (runReplayWalkForward only records an entry when a real trade occurs) -
  // without this, it would silently vanish instead of correctly reporting NO_EVIDENCE.
  const strategyIds = new Set<string>(requestedStrategyIds);
  for (const f of folds) for (const s of Object.keys(f.strategyStats)) strategyIds.add(s);

  const verdicts: StrategyWalkForwardVerdict[] = [];
  for (const strategyId of strategyIds) {
    const perFold = folds.map((f) => f.strategyStats[strategyId]).filter(Boolean);
    const totalClosedTrades = perFold.reduce((s, f) => s + f.closedTrades, 0);
    const totalNetPnl = perFold.reduce((s, f) => s + f.netPnl, 0);

    if (totalClosedTrades === 0) {
      verdicts.push({
        strategyId, totalClosedTrades: 0, totalNetPnl: 0, foldsWithEvidence: 0, foldsAboveChance: 0, foldsBelowChance: 0,
        status: 'NO_EVIDENCE', reason: 'This strategy produced zero real closed round-trips across every replay fold.',
      });
      continue;
    }

    const judgeable = perFold.filter((f) => f.closedTrades >= minTradesPerFold);
    if (judgeable.length < 2) {
      verdicts.push({
        strategyId, totalClosedTrades, totalNetPnl, foldsWithEvidence: judgeable.length, foldsAboveChance: 0, foldsBelowChance: 0,
        status: 'INSUFFICIENT_SAMPLE',
        reason: `Only ${judgeable.length} of ${perFold.length} folds have >= ${minTradesPerFold} closed trades to judge (need >=2 to compare) - too little real replay evidence yet.`,
      });
      continue;
    }

    const foldVerdicts = judgeable.map((f) => wilsonInterval(f.wins, f.closedTrades));
    const aboveChance = foldVerdicts.filter((w) => w.lower !== null && w.lower > 0.5).length;
    const belowChance = foldVerdicts.filter((w) => w.upper !== null && w.upper < 0.5).length;

    if (aboveChance > 0 && belowChance > 0) {
      verdicts.push({
        strategyId, totalClosedTrades, totalNetPnl, foldsWithEvidence: judgeable.length, foldsAboveChance: aboveChance, foldsBelowChance: belowChance,
        status: 'INCONSISTENT',
        reason: `${aboveChance} fold(s) sit clearly above chance and ${belowChance} sit clearly below chance across real replay windows - not a stable edge.`,
      });
    } else if (aboveChance === judgeable.length) {
      verdicts.push({
        strategyId, totalClosedTrades, totalNetPnl, foldsWithEvidence: judgeable.length, foldsAboveChance: aboveChance, foldsBelowChance: belowChance,
        status: 'CONSISTENT_ABOVE_CHANCE',
        reason: `All ${judgeable.length} judgeable replay folds sit above chance.`,
      });
    } else if (belowChance === judgeable.length) {
      verdicts.push({
        strategyId, totalClosedTrades, totalNetPnl, foldsWithEvidence: judgeable.length, foldsAboveChance: aboveChance, foldsBelowChance: belowChance,
        status: 'CONSISTENT_BELOW_CHANCE',
        reason: `All ${judgeable.length} judgeable replay folds sit at or below chance.`,
      });
    } else {
      verdicts.push({
        strategyId, totalClosedTrades, totalNetPnl, foldsWithEvidence: judgeable.length, foldsAboveChance: aboveChance, foldsBelowChance: belowChance,
        status: 'INSUFFICIENT_SAMPLE',
        reason: 'No fold clearly resolves above or below chance.',
      });
    }
  }
  return verdicts.sort((a, b) => b.totalClosedTrades - a.totalClosedTrades);
}
