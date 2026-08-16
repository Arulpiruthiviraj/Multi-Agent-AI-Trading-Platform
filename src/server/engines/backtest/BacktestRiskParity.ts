/**
 * Shared circuit-breaker math used by live RiskEngine and BacktestEngine.
 * Backtest cannot call RiskEngine (live broker, news). Predicates match tradingSafety.json.
 */
import { tradingSafety } from '../../config/tradingSafety';
import { evaluateAllocationGuard, snapshotCapital } from '../CapitalAllocation';
import {
  MAX_CORRELATED_EXPOSURE_PCT,
  MAX_SECTOR_CONCENTRATION_PCT,
  MAX_SINGLE_SYMBOL_CONCENTRATION_PCT,
  getSector,
  returnCorrelation,
} from '../PositionSizing';

export function dailyLossBlocksNewBuys(input: {
  equityNow: number;
  dayStartEquity: number;
  dailyLossLimitDollars: number;
}): boolean {
  const dailyLoss = Math.max(0, input.dayStartEquity - input.equityNow);
  return dailyLoss >= input.dailyLossLimitDollars * tradingSafety.dailyLossKillSwitchFraction;
}

export function consecutiveLossBlocksNewBuys(recentClosedPnlsNewestFirst: number[]): boolean {
  const n = tradingSafety.maxConsecutiveLosses;
  if (recentClosedPnlsNewestFirst.length < n) return false;
  return recentClosedPnlsNewestFirst.slice(0, n).every(p => p < 0);
}

export function drawdownBlocksNewBuys(input: {
  equityNow: number;
  peakEquity: number;
  maxPortfolioDrawdownPct: number;
}): boolean {
  const drawdownPct = input.peakEquity > 0
    ? Math.max(0, (input.peakEquity - input.equityNow) / input.peakEquity)
    : 0;
  return drawdownPct >= input.maxPortfolioDrawdownPct;
}

/** Live gate counts risk_assessments in the last 60s. Backtest counts BUY fills in the same window of simulated time. */
export function orderRateBlocksNewBuys(input: {
  buyTimestampsMs: number[];
  nowMs: number;
  maxOrdersPerMinute: number;
}): boolean {
  const recent = input.buyTimestampsMs.filter(t => input.nowMs - t < 60_000).length;
  return recent >= input.maxOrdersPerMinute;
}

export function nySessionKey(timestampMs: number): string {
  return new Date(timestampMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function allocationBlocksNewBuy(input: {
  allocatedBudget: number;
  positions: Array<{ quantity: number; averagePrice?: number; avgPrice?: number }>;
  requestedNotional: number;
}): boolean {
  const snap = snapshotCapital({
    allocated: input.allocatedBudget,
    positions: input.positions,
    pendingBuys: [],
  });
  return !evaluateAllocationGuard(snap, 'BUY', input.requestedNotional).passed;
}

export function symbolConcentrationBlocksNewBuy(input: {
  equityNow: number;
  existingQty: number;
  currentPrice: number;
  additionalQty: number;
}): boolean {
  if (!(input.equityNow > 0) || !(input.currentPrice > 0)) return true;
  const existingValue = input.existingQty * input.currentPrice;
  const addValue = input.additionalQty * input.currentPrice;
  return existingValue + addValue > input.equityNow * MAX_SINGLE_SYMBOL_CONCENTRATION_PCT + 1e-9;
}

export function sectorConcentrationBlocksNewBuy(input: {
  equityNow: number;
  symbol: string;
  existingPositions: Array<{ symbol: string; quantity: number }>;
  currentPrice: number;
  additionalQty: number;
}): boolean {
  const sector = getSector(input.symbol);
  if (!sector) return false;
  if (!(input.equityNow > 0)) return true;
  const sectorValue = input.existingPositions.reduce(
    (sum, p) => getSector(p.symbol) === sector ? sum + p.quantity * input.currentPrice : sum,
    0,
  );
  return sectorValue + input.additionalQty * input.currentPrice > input.equityNow * MAX_SECTOR_CONCENTRATION_PCT + 1e-9;
}

export async function correlationExposureBlocksNewBuy(input: {
  equityNow: number;
  symbol: string;
  existingPositions: Array<{ symbol: string; quantity: number }>;
  currentPrice: number;
  additionalQty: number;
  getRecentCloses: (symbol: string) => Promise<number[] | null>;
}): Promise<boolean> {
  if (!(input.equityNow > 0)) return true;
  if (input.existingPositions.length === 0) return false;
  const proposalCloses = await input.getRecentCloses(input.symbol);
  if (!proposalCloses) return false;
  let correlatedValue = 0;
  for (const p of input.existingPositions) {
    if (p.symbol === input.symbol) {
      correlatedValue += p.quantity * input.currentPrice;
      continue;
    }
    const otherCloses = await input.getRecentCloses(p.symbol);
    if (!otherCloses) continue;
    const corr = returnCorrelation(proposalCloses, otherCloses);
    if (corr !== null && corr > tradingSafety.correlationThreshold) {
      correlatedValue += p.quantity * input.currentPrice;
    }
  }
  correlatedValue += input.additionalQty * input.currentPrice;
  return correlatedValue > input.equityNow * MAX_CORRELATED_EXPOSURE_PCT + 1e-9;
}

/**
 * Fail-closed session check. Daily bars represent a completed RTH session: only weekends block.
 * Intraday: NY minutes must fall in [usEquityRthOpenMinute, usEquityRthCloseMinute).
 */
export function marketHoursBlocksNewBuys(timestampMs: number, timeframe: string): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestampMs));
  const weekday = parts.find(p => p.type === 'weekday')?.value;
  if (weekday === 'Sat' || weekday === 'Sun') return true;
  const tf = (timeframe || '1Day').toLowerCase();
  if (tf === '1day' || tf === 'day' || tf === '1d') return false;
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true;
  const mins = hour * 60 + minute;
  return mins < tradingSafety.usEquityRthOpenMinute || mins >= tradingSafety.usEquityRthCloseMinute;
}
