/**
 * Organic paper counting. Rejected, cancelled, unit-test, replay, and backtest rows are not organic.
 */
import { getTradingDateStr } from '../core/TradingCalendar';

export type ExecutionEnvironment = 'BACKTEST' | 'REPLAY' | 'SIMULATION' | 'PAPER' | 'LIVE' | 'UNKNOWN';

const TEST_TRACE = /^(test|qa-|gates-|crash-|lifecycle-|vitest|diag-)/i;

export function classifyTradeEnvironment(row: {
  traceId?: string | null;
  reasoning?: string | null;
  executionEnvironment?: string | null;
}): ExecutionEnvironment {
  const tagged = row.executionEnvironment?.toUpperCase();
  // EXTERNAL_SYNC / PRE_EXISTING_RECONCILED / HISTORICAL_SIMULATION never count as PAPER.
  if (
    tagged === 'EXTERNAL_SYNC'
    || tagged === 'PRE_EXISTING_RECONCILED'
    || tagged === 'EXTERNAL_MANUAL'
    || tagged === 'HISTORICAL_SIMULATION'
    || tagged === 'HISTORICAL_REPLAY'
  ) {
    return 'UNKNOWN';
  }
  if (tagged === 'BACKTEST' || tagged === 'REPLAY' || tagged === 'SIMULATION' || tagged === 'PAPER' || tagged === 'LIVE') {
    return tagged;
  }
  const reason = (row.reasoning ?? '');
  const upper = reason.toUpperCase();
  // Operator overrides must not be classified as PAPER even if OMS later stamps executionEnvironment=PAPER.
  if (upper.includes('SOURCE: MANUAL_OVERRIDE') || upper.includes('SOURCE: EXTERNAL_MANUAL')) return 'UNKNOWN';
  if (upper.includes('PRE_EXISTING_RECONCILED') || upper.includes('EXTERNAL_SYNC')) return 'UNKNOWN';
  if (upper.includes('HISTORICAL_SIMULATION') || upper.includes('HISTORICAL REPLAY')) return 'REPLAY';
  if (row.traceId && /^manual-override-/i.test(row.traceId)) return 'UNKNOWN';
  // DIAG* symbols / traces from diagnostic harnesses are never organic paper.
  if (row.traceId && /diag/i.test(row.traceId)) return 'UNKNOWN';
  const stamped = reason.match(/executionEnvironment=(BACKTEST|REPLAY|SIMULATION|PAPER|LIVE|HISTORICAL_SIMULATION|EXTERNAL_SYNC)\b/i);
  if (stamped) {
    const v = stamped[1].toUpperCase();
    if (v === 'HISTORICAL_SIMULATION' || v === 'EXTERNAL_SYNC') return 'UNKNOWN';
    return v as ExecutionEnvironment;
  }
  if (upper.includes('BACKTEST')) return 'BACKTEST';
  if (upper.includes('REPLAY')) return 'REPLAY';
  if (upper.includes('SIMULATION')) return 'SIMULATION';
  if (row.traceId && TEST_TRACE.test(row.traceId)) return 'UNKNOWN';
  return 'UNKNOWN';
}

export function isOrganicClosedPaper(row: {
  status: string;
  side: string;
  profitLoss?: number | null;
  traceId?: string | null;
  reasoning?: string | null;
  timestamp?: string | null;
  filledAt?: string | null;
  executionEnvironment?: string | null;
  symbol?: string | null;
}): boolean {
  if (row.status !== 'FILLED' || row.side !== 'SELL' || typeof row.profitLoss !== 'number') return false;
  if (row.symbol && /^DIAG/i.test(row.symbol)) return false;
  const reason = (row.reasoning ?? '').toUpperCase();
  if (reason.includes('SOURCE: MANUAL_OVERRIDE') || reason.includes('SOURCE: EXTERNAL_MANUAL')) return false;
  if (row.traceId && /^manual-override-/i.test(row.traceId)) return false;
  const env = classifyTradeEnvironment(row);
  if (env !== 'PAPER') return false;
  if (row.traceId && TEST_TRACE.test(row.traceId)) return false;
  return true;
}

/**
 * Any FILLED PAPER trade that counts toward organic soak *entry* evidence
 * (BUY or SELL). Unlike isOrganicClosedPaper, does not require numeric P&L —
 * used by FirstFillForensicCheckpoint to trigger on the first organic fill.
 */
export function isOrganicPaperFill(row: {
  status: string;
  side?: string | null;
  profitLoss?: number | null;
  traceId?: string | null;
  reasoning?: string | null;
  executionEnvironment?: string | null;
  symbol?: string | null;
}): boolean {
  if (row.status !== 'FILLED') return false;
  if (row.symbol && /^DIAG/i.test(row.symbol)) return false;
  const reason = (row.reasoning ?? '').toUpperCase();
  if (reason.includes('SOURCE: MANUAL_OVERRIDE') || reason.includes('SOURCE: EXTERNAL_MANUAL')) return false;
  if (row.traceId && /^manual-override-/i.test(row.traceId)) return false;
  if (row.traceId && TEST_TRACE.test(row.traceId)) return false;
  return classifyTradeEnvironment(row) === 'PAPER';
}

/** OMS-only. Unknown adapters stay UNKNOWN so they cannot inflate organic paper. */
export function resolveOmsExecutionEnvironment(opts: {
  brokerId?: string | null;
  tradingMode?: string | null;
}): ExecutionEnvironment {
  const mode = String(opts.tradingMode || '').toUpperCase();
  const id = String(opts.brokerId || '');
  if (id === 'historical_replay') return 'REPLAY';
  if (mode === 'LIVE') {
    if (id === 'alpaca' || id === 'ibkr' || id === 'coinbase') return 'LIVE';
    return 'UNKNOWN';
  }
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

export function countOrganicPaperSessions(
  rows: Array<{
    status: string;
    side: string;
    profitLoss?: number | null;
    traceId?: string | null;
    reasoning?: string | null;
    executionEnvironment?: string | null;
    timestamp?: string | null;
    filledAt?: string | null;
  }>,
): number {
  const days = new Set<string>();
  for (const row of rows) {
    if (!isOrganicClosedPaper(row)) continue;
    const raw = row.filledAt || row.timestamp;
    if (!raw) continue;
    const t = new Date(raw);
    if (Number.isNaN(t.getTime())) continue;
    days.add(getTradingDateStr(t));
  }
  return days.size;
}

export function summarizeOrganicPaper(
  rows: Array<{
    status: string;
    side: string;
    profitLoss?: number | null;
    traceId?: string | null;
    reasoning?: string | null;
    executionEnvironment?: string | null;
    timestamp?: string | null;
    filledAt?: string | null;
  }>,
  minSampleForSharpe: number,
): {
  closedTradeCount: number;
  sessionCount: number;
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
  const sessionCount = countOrganicPaperSessions(rows);
  const empty = {
    closedTradeCount: n,
    sessionCount,
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
