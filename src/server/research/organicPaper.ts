/**
 * Organic paper counting. Rejected, cancelled, unit-test, replay, and backtest rows are not organic.
 */
export type ExecutionEnvironment = 'BACKTEST' | 'REPLAY' | 'SIMULATION' | 'PAPER' | 'LIVE' | 'UNKNOWN';

const TEST_TRACE = /^(test|qa-|gates-|crash-|lifecycle-|vitest)/i;

export function classifyTradeEnvironment(row: {
  traceId?: string | null;
  reasoning?: string | null;
  executionEnvironment?: string | null;
}): ExecutionEnvironment {
  const tagged = row.executionEnvironment?.toUpperCase();
  if (tagged === 'BACKTEST' || tagged === 'REPLAY' || tagged === 'SIMULATION' || tagged === 'PAPER' || tagged === 'LIVE') {
    return tagged;
  }
  const reason = (row.reasoning ?? '');
  const stamped = reason.match(/executionEnvironment=(BACKTEST|REPLAY|SIMULATION|PAPER|LIVE)\b/i);
  if (stamped) return stamped[1].toUpperCase() as ExecutionEnvironment;
  const upper = reason.toUpperCase();
  if (upper.includes('BACKTEST')) return 'BACKTEST';
  if (upper.includes('REPLAY')) return 'REPLAY';
  if (upper.includes('SIMULATION')) return 'SIMULATION';
  if (upper.includes('SOURCE: EXTERNAL_MANUAL')) return 'UNKNOWN';
  if (row.traceId && TEST_TRACE.test(row.traceId)) return 'UNKNOWN';
  return 'UNKNOWN';
}

export function isOrganicClosedPaper(row: {
  status: string;
  side: string;
  profitLoss?: number | null;
  traceId?: string | null;
  reasoning?: string | null;
  executionEnvironment?: string | null;
}): boolean {
  if (row.status !== 'FILLED' || row.side !== 'SELL' || typeof row.profitLoss !== 'number') return false;
  const env = classifyTradeEnvironment(row);
  if (env !== 'PAPER') return false;
  if (row.traceId && TEST_TRACE.test(row.traceId)) return false;
  return true;
}

/** OMS-only. Unknown adapters stay UNKNOWN so they cannot inflate organic paper. */
export function resolveOmsExecutionEnvironment(opts: {
  brokerId?: string | null;
  tradingMode?: string | null;
}): ExecutionEnvironment {
  const mode = String(opts.tradingMode || '').toUpperCase();
  const id = String(opts.brokerId || '');
  if (mode === 'LIVE') return 'LIVE';
  if (id === 'internal_paper') return 'PAPER';
  if (mode === 'PAPER' && (id === 'alpaca' || id === 'ibkr' || id === 'coinbase' || id === 'questrade')) {
    return 'PAPER';
  }
  return 'UNKNOWN';
}

export function stampExecutionEnvironment(reasoning: string, env: ExecutionEnvironment): string {
  if (/executionEnvironment=/.test(reasoning)) return reasoning;
  const base = reasoning?.trim() ? reasoning.trim() : '';
  return base ? `${base} executionEnvironment=${env}` : `executionEnvironment=${env}`;
}

export function summarizeOrganicPaper(
  rows: Array<{
    status: string;
    side: string;
    profitLoss?: number | null;
    traceId?: string | null;
    reasoning?: string | null;
    executionEnvironment?: string | null;
  }>,
  minSampleForSharpe: number,
): {
  closedTradeCount: number;
  sampleSize: number;
  grossPnl: number | null;
  winRate: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  sharpe: { status: 'INSUFFICIENT_SAMPLE' | 'OK'; sampleSize: number; value: number | null };
  invented: false;
  note: string;
} {
  const organic = rows.filter(isOrganicClosedPaper);
  const pnls = organic.map((r) => r.profitLoss as number);
  const n = pnls.length;
  const empty = {
    closedTradeCount: n,
    sampleSize: n,
    grossPnl: n ? pnls.reduce((s, v) => s + v, 0) : null,
    winRate: null as number | null,
    expectancy: null as number | null,
    profitFactor: null as number | null,
    sharpe: { status: 'INSUFFICIENT_SAMPLE' as const, sampleSize: n, value: null as number | null },
    invented: false as const,
    note: n === 0
      ? 'No organic PAPER FILLED SELL rows with P&L. Not an edge. Not LIVE_CANDIDATE evidence.'
      : 'Organic paper sample only. Sharpe withheld below minSampleForSharpe.',
  };
  if (n === 0) return empty;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const winRate = wins.length / n;
  const expectancy = pnls.reduce((s, v) => s + v, 0) / n;
  const grossWin = wins.reduce((s, v) => s + v, 0);
  const grossLossAbs = Math.abs(losses.reduce((s, v) => s + v, 0));
  const profitFactor = grossLossAbs > 0 ? grossWin / grossLossAbs : null;
  if (n < minSampleForSharpe) {
    return { ...empty, winRate, expectancy, profitFactor };
  }
  const mean = expectancy;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);
  const value = stdev > 0 ? mean / stdev : null;
  return {
    ...empty,
    winRate,
    expectancy,
    profitFactor,
    sharpe: value === null
      ? { status: 'INSUFFICIENT_SAMPLE', sampleSize: n, value: null }
      : { status: 'OK', sampleSize: n, value: Number(value.toFixed(4)) },
    note: 'Organic paper sample. Not a validated edge by itself.',
  };
}
