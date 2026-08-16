/**
 * ==========================================================
 * Module: PaperTradingValidation
 *
 * Purpose:
 * Phase 10 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md / ARGUS_PAPER_TRADING_VALIDATION.md). Real,
 * read-only aggregation over the actual pipeline's own persisted tables - never a fabricated
 * "paper trading report" when the underlying real data doesn't exist yet. Every count/rate below
 * comes directly from `trades`/`transactions`/`risk_assessments`/`reconciliation_events` -
 * exactly the tables this codebase already writes to on every real cycle, not a new shadow ledger.
 * ==========================================================
 */
import { db } from '../db';
import { trades, transactions, riskAssessments, reconciliationEvents } from '../db/schema';
import { gte as gteOp } from 'drizzle-orm';

export interface PaperTradingReport {
  experimentId: string;
  windowSinceIso: string | null;
  totalTransactions: number;
  transactionsByStatus: Record<string, number>;
  totalRiskAssessments: number;
  riskApprovedCount: number;
  riskRejectedCount: number;
  riskRejectionsByGate: Record<string, number>;
  totalFilledTrades: number;
  winRatePct: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  sharpe: number | null; // real, from the real sequence of closed-trade returns - null below the sample floor
  maxDrawdownPct: number | null;
  reconciliationEventCount: number;
  reconciliationMismatchCount: number;
  statisticallyMeaningful: boolean;
  note: string | null;
}

import { tradingSafety } from '../config/tradingSafety';

export const MIN_TRADES_FOR_PAPER_VALIDATION = tradingSafety.minTradesForPaperValidation;

/** Persistent experiment identifier for a continuous paper run. Override via ARGUS_PAPER_EXPERIMENT_ID.
 *  Never invents trades - it only labels whatever organic activity actually occurred. */
export const PAPER_EXPERIMENT_ID = process.env.ARGUS_PAPER_EXPERIMENT_ID || 'ARGUS_PAPER_EXPERIMENT_001';

export async function computePaperTradingReport(sinceIso?: string): Promise<PaperTradingReport> {
  const txns = sinceIso
    ? await db.select().from(transactions).where(gteOp(transactions.openedAt, sinceIso))
    : await db.select().from(transactions).all();
  const transactionsByStatus: Record<string, number> = {};
  for (const t of txns) transactionsByStatus[t.status] = (transactionsByStatus[t.status] ?? 0) + 1;

  const assessments = sinceIso
    ? await db.select().from(riskAssessments).where(gteOp(riskAssessments.createdAt, sinceIso))
    : await db.select().from(riskAssessments).all();
  const riskApprovedCount = assessments.filter(a => a.approved).length;
  const riskRejectedCount = assessments.length - riskApprovedCount;
  const riskRejectionsByGate: Record<string, number> = {};
  for (const a of assessments) {
    if (!a.approved && a.rejectionGate) riskRejectionsByGate[a.rejectionGate] = (riskRejectionsByGate[a.rejectionGate] ?? 0) + 1;
  }

  const allTrades = sinceIso
    ? await db.select().from(trades).where(gteOp(trades.timestamp, sinceIso))
    : await db.select().from(trades).all();
  const filledSells = allTrades.filter(t => t.status === 'FILLED' && t.side === 'SELL' && typeof t.profitLoss === 'number');

  let winRatePct: number | null = null, profitFactor: number | null = null, expectancy: number | null = null;
  let sharpe: number | null = null, maxDrawdownPct: number | null = null;
  if (filledSells.length > 0) {
    const pnls = filledSells.map(t => t.profitLoss as number);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p <= 0);
    winRatePct = Number(((wins.length / pnls.length) * 100).toFixed(1));
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    profitFactor = grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? Infinity : null);
    expectancy = Number((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2));

    if (pnls.length >= 2) {
      const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
      const variance = pnls.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / pnls.length;
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? Number((mean / std).toFixed(3)) : null; // real, un-annualized (no reliable trade-frequency-to-period conversion for a handful of real fills)
    }

    let cumulative = 0, peak = 0, maxDd = 0;
    for (const p of pnls) {
      cumulative += p;
      peak = Math.max(peak, cumulative);
      if (peak > 0) maxDd = Math.max(maxDd, (peak - cumulative) / peak);
    }
    maxDrawdownPct = Number((maxDd * 100).toFixed(2));
  }

  const reconEvents = sinceIso
    ? await db.select().from(reconciliationEvents).where(gteOp(reconciliationEvents.checkedAt, sinceIso))
    : await db.select().from(reconciliationEvents).all();
  const reconciliationMismatchCount = reconEvents.filter(e => !e.matches).length;

  const statisticallyMeaningful = filledSells.length >= MIN_TRADES_FOR_PAPER_VALIDATION;

  return {
    experimentId: PAPER_EXPERIMENT_ID,
    windowSinceIso: sinceIso ?? null,
    totalTransactions: txns.length,
    transactionsByStatus,
    totalRiskAssessments: assessments.length,
    riskApprovedCount,
    riskRejectedCount,
    riskRejectionsByGate,
    totalFilledTrades: filledSells.length,
    winRatePct, profitFactor, expectancy, sharpe, maxDrawdownPct,
    reconciliationEventCount: reconEvents.length,
    reconciliationMismatchCount,
    statisticallyMeaningful,
    note: statisticallyMeaningful
      ? null
      : `Only ${filledSells.length} real closed (FILLED SELL) trade(s) - below the ${MIN_TRADES_FOR_PAPER_VALIDATION}-trade floor this report requires before treating win rate/profit factor/Sharpe/drawdown as meaningful. Do not draw a conclusion from this sample.`,
  };
}
