/**
 * Honest labels + hover copy for Transaction Observatory placeholders.
 * Does not invent BUY/SELL, win rate, or P&L. N/A means not applicable, not missing.
 */

export const RIBBON_BROKER_UNAVAILABLE =
  'Broker portfolio has not loaded (GET /api/v1/portfolio failed or has not returned). This is not caused by Autobot being stopped or by PAPER mode. Paper Internal Simulator would report cash/equity (default $100,000) once the call succeeds. Retry after the API is up; a 502 means the active broker itself threw.';

export const RIBBON_HEALTH_UNAVAILABLE =
  'Argus does not compute a 0–100 portfolio health score. RiskEngine uses individual gates (daily loss, drawdown, concentration, …), not this ribbon number. It stays -- until a real health_score is added to the broker snapshot — we will not invent one.';

export const WIN_RATE_UNAVAILABLE =
  'DATA UNAVAILABLE is correct: there are no filled trades with booked P&L today, so there is nothing to score. This is not a 0% win rate. It appears after organic closed fills (typically filled SELLs) write profitLoss on the trades table. Autobot STOPPED and MARKET CLOSED mean no new fills. NO_CONSENSUS Observatory rows are not trades.';

export const REALIZED_PNL_UNAVAILABLE =
  'DATA UNAVAILABLE is correct: realized P&L is the sum of booked profitLoss on today\'s filled trades. Zero closed fills → nothing to sum (not $0.00 fabricated as a session result). It appears after a filled SELL books P&L. Unrealized marks on open positions are a different field.';

export const AGENTS_INACTIVE =
  'Active = a pipeline agent (Technical, News, Fundamental, Macro, Kronos) logged a prediction in the last ~3 minutes. Autobot STOPPED calls system.stop() and those engines go idle, so 0/5 is expected. The count rises after Autobot is running and a real TRADE_IDEA_GENERATED is logged — not while the bot is stopped.';

export const AI_MODELS_PARTIAL =
  'Healthy / total counts enabled rows in ai_providers with health=Healthy — not a live ping of every model name. A low healthy count usually means missing keys, a failed last health check, or disabled providers. It does not by itself block RiskEngine.';

export const TRADES_TODAY_HINT =
  'Filled rows in the trades table whose timestamp is today (UTC date prefix). Observatory NO_CONSENSUS / RISK_REJECTED cycles are decision records, not fills, and do not increment this.';

export interface ObservatoryTxRow {
  finalDecision: string | null;
  status: string;
  outcome: string;
  proposedSide?: string | null;
  weightedConfidence?: number | null;
  consensusThreshold?: number | null;
}

export function formatTransactionDecision(row: ObservatoryTxRow): {
  label: string;
  title: string;
  kind: 'buy' | 'sell' | 'hold' | 'none';
} {
  if (row.finalDecision) {
    const kind = row.finalDecision === 'BUY' ? 'buy' : row.finalDecision === 'SELL' ? 'sell' : 'hold';
    return {
      label: row.finalDecision,
      title: `ChiefTrader approved ${row.finalDecision} (status ${row.status}).`,
      kind,
    };
  }

  const confBit =
    typeof row.weightedConfidence === 'number' && typeof row.consensusThreshold === 'number'
      ? ` Best aggregated side was ${row.proposedSide ?? 'unknown'} at ${(row.weightedConfidence * 100).toFixed(1)}% vs ${(row.consensusThreshold * 100).toFixed(0)}% threshold — not approved.`
      : '';

  if (row.status === 'NO_CONSENSUS') {
    return {
      label: 'NO TRADE',
      title: `No approved side — agents did not reach consensus.${confBit} This is not a BUY or SELL. Outcome is N/A because no order was placed.`,
      kind: 'none',
    };
  }

  return {
    label: 'NO TRADE',
    title: `No approved side was recorded (status ${row.status}). Decision stays empty until ChiefTrader emits CHIEF_APPROVED_IDEA.${confBit}`,
    kind: 'none',
  };
}

export function formatTransactionOutcome(row: Pick<ObservatoryTxRow, 'outcome' | 'status'>): {
  label: string;
  title: string;
} {
  if (row.outcome === 'N_A' || row.outcome === 'N/A') {
    return {
      label: 'N/A',
      title: `Not applicable: this cycle never filled, so there is no WIN/LOSS to score. N/A is correct for ${row.status} (no fill). WIN/LOSS appears only after a filled SELL books realized P&L in trades.`,
    };
  }
  if (row.outcome === 'PENDING') {
    return {
      label: 'PENDING',
      title: 'Consensus approved this idea; WIN/LOSS is scored only after a filled close (typically a SELL) books profitLoss. Open or unfilled orders stay PENDING.',
    };
  }
  if (row.outcome === 'WIN') {
    return { label: 'WIN', title: 'Booked profitLoss on a filled close was >= 0.' };
  }
  if (row.outcome === 'LOSS') {
    return { label: 'LOSS', title: 'Booked profitLoss on a filled close was < 0.' };
  }
  return {
    label: row.outcome || '--',
    title: row.outcome
      ? `Outcome ${row.outcome} as stored on the transaction row.`
      : 'No outcome recorded on this transaction row.',
  };
}

export function formatStatusHint(status: string): string {
  switch (status) {
    case 'NO_CONSENSUS':
      return 'Real pipeline state: ChiefTrader closed the evaluation window without crossing the consensus threshold. No CHIEF_APPROVED_IDEA, so RiskEngine and OMS never ran. Not a bug.';
    case 'OPEN':
      return 'Consensus approved; waiting on RiskEngine / order placement.';
    case 'RISK_REJECTED':
      return 'ChiefTrader approved, RiskEngine refused. See the transaction trace for the failing gate.';
    case 'EXECUTED':
      return 'Order submitted to the broker; waiting on fill.';
    case 'ORDER_REJECTED':
      return 'Broker rejected or canceled the order after risk approval.';
    case 'FILLED':
      return 'Broker fill recorded on the trades table.';
    case 'RECONCILED':
      return 'Fill reconciled against broker state.';
    default:
      return `Transaction status ${status} as stored on the ledger.`;
  }
}
