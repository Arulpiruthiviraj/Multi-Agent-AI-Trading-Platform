export type ReplayResultLabel = 'WIN' | 'LOSS' | 'FLAT';

export interface ReplayLedgerRow {
  entryTime: string;
  exitTime: string;
  symbol: string;
  action: 'BUY_THEN_SELL';
  quantity: number;
  entry: number;
  exit: number;
  pnl: number | null;
  pnlPct: number | null;
  rMultiple: number | null;
  result: ReplayResultLabel;
  predictedSide: 'BUY';
  actualDirection: 'UP' | 'DOWN' | 'FLAT';
  predictionCorrect: boolean | null;
  failureCategory: string | null;
  failureDetail: string | null;
  entryRegime: string | null;
}

/** Pair sequential BUY/SELL rows from BacktestEngine trade logs. Long-only. */
export function buildReplayLedger(tradeLog: Array<Record<string, any>>, defaultSymbol = ''): ReplayLedgerRow[] {
  const rows: ReplayLedgerRow[] = [];
  let open: Record<string, any> | null = null;
  for (const t of tradeLog || []) {
    if (t.side === 'BUY') {
      open = t;
      continue;
    }
    if (t.side === 'SELL' && open) {
      const entry = Number(open.price);
      const exit = Number(t.price);
      const pnl = typeof t.realizedPnl === 'number' ? t.realizedPnl : null;
      const pnlPct = Number.isFinite(entry) && entry !== 0 && Number.isFinite(exit)
        ? ((exit - entry) / entry) * 100
        : null;
      let result: ReplayResultLabel = 'FLAT';
      if (pnl != null) {
        if (pnl > 0) result = 'WIN';
        else if (pnl < 0) result = 'LOSS';
      } else if (pnlPct != null) {
        if (pnlPct > 0) result = 'WIN';
        else if (pnlPct < 0) result = 'LOSS';
      }
      const actualDirection = result === 'WIN' ? 'UP' : result === 'LOSS' ? 'DOWN' : 'FLAT';
      rows.push({
        entryTime: new Date(open.timestamp).toISOString(),
        exitTime: new Date(t.timestamp).toISOString(),
        symbol: String(t.symbol || open.symbol || defaultSymbol),
        action: 'BUY_THEN_SELL',
        quantity: Number(t.quantity || open.quantity || 0),
        entry,
        exit,
        pnl,
        pnlPct,
        rMultiple: typeof t.rMultiple === 'number' ? t.rMultiple : null,
        result,
        predictedSide: 'BUY',
        actualDirection,
        predictionCorrect: result === 'FLAT' ? null : result === 'WIN',
        failureCategory: t.failureCategory ?? null,
        failureDetail: t.failureDetail ?? null,
        entryRegime: t.entryRegime ?? null,
      });
      open = null;
    }
  }
  return rows;
}

export function overconfidenceFlags(ledger: ReplayLedgerRow[]): {
  highRLosses: number;
  note: string;
  aiConfidenceLosses: 'UNAVAILABLE';
  aiConfidenceLossesReason: string;
} {
  const highRLosses = ledger.filter(r => r.result === 'LOSS' && r.rMultiple != null && r.rMultiple <= -0.9).length;
  return {
    highRLosses,
    note: highRLosses > 0
      ? `${highRLosses} closed trade(s) gave back ~1R or more (stop-like). This is a risk/calibration signal for the deterministic strategy only.`
      : 'No ~1R stop-like losses in this ledger.',
    aiConfidenceLosses: 'UNAVAILABLE',
    aiConfidenceLossesReason: 'Strategy backtests do not record Kronos/Chronos/ChiefTrader confidence. High-confidence AI losses cannot be counted without fabricating those fields.',
  };
}
