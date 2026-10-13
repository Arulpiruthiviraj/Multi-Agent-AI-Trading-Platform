/**
 * researchEquity.ts - research-capital basis for the daily-loss and drawdown brakes.
 *
 * 2026-10-12: those two gates measured the BROKER account equity (~$1M simulated IBKR paper), so a
 * $20,000 research budget with a $250 daily-loss limit compared $250 against whole-account equity
 * movement and the 5% drawdown limit meant ~$50,000. When `researchEquityRiskBasisEnabled` is on,
 * both gates use Argus's own P&L on top of `settings.budget`:
 *
 *   research equity = budget + realized P&L (FILLED PAPER sells, all time) + unrealized P&L of held positions
 *   daily loss      = -(realized P&L today (NY day) + unrealized P&L now), floored at 0
 *   drawdown        = (peak - equity) / peak, peak = max(realized-only curve, in-process running peak, now)
 *
 * Known limits (documented, conservative): unrealized P&L on a carried position is counted in full on the
 * day it is observed (no persisted previous-close mark), which can only OVER-state the daily loss; the
 * unrealized component of the historical peak is remembered in-process only, so right after a restart the
 * drawdown can UNDER-state a pre-restart unrealized peak. Pure functions + one bounded read-only DB query.
 */
export interface ResearchTradeRow { profitLoss: number | null; filledAt: string | null }
/** One FILLED PAPER order's real broker commission (BUY or SELL). NULL = no real evidence: counted as 0, never guessed. */
export interface ResearchFeeRow { commission: number | null; filledAt: string | null }
export interface ResearchPositionRow { quantity: number; entryPrice: number | null; currentPrice: number | null; unrealizedPnl: number | null }

export interface ResearchEquitySnapshot {
  budget: number;
  realizedAllTime: number;
  realizedToday: number;
  /** 2026-10-13: real commissions (entry + exit) already deducted from equity/dailyLoss; trades.profit_loss itself stays GROSS. */
  feesAllTime: number;
  feesToday: number;
  unrealized: number;
  unrealizedUnvaluedPositions: number;
  equity: number;
  dailyLoss: number;
  peakEquity: number;
  drawdownPct: number;
}

export function positionUnrealized(p: ResearchPositionRow): number | null {
  if (Number.isFinite(p.unrealizedPnl as number)) return p.unrealizedPnl as number;
  if (Number.isFinite(p.currentPrice as number) && Number.isFinite(p.entryPrice as number)) {
    return ((p.currentPrice as number) - (p.entryPrice as number)) * p.quantity;
  }
  return null;
}

let runningPeak: number | null = null;
export function resetResearchPeakForTests(): void { runningPeak = null; }

export function computeResearchEquity(input: {
  budget: number;
  closedTrades: ResearchTradeRow[];
  /** Optional: when supplied, equity / daily loss / drawdown are NET of these real commissions. */
  fills?: ResearchFeeRow[];
  positions: ResearchPositionRow[];
  isToday: (filledAtIso: string) => boolean;
}): ResearchEquitySnapshot {
  const closed = input.closedTrades
    .filter((t) => Number.isFinite(t.profitLoss as number) && typeof t.filledAt === 'string')
    .sort((a, b) => (a.filledAt as string).localeCompare(b.filledAt as string));
  const feeEvents = (input.fills ?? [])
    .filter((f) => Number.isFinite(f.commission as number) && typeof f.filledAt === 'string')
    .map((f) => ({ at: f.filledAt as string, delta: -(f.commission as number) }));
  const events = [
    ...closed.map((t) => ({ at: t.filledAt as string, delta: t.profitLoss as number })),
    ...feeEvents,
  ].sort((a, b) => a.at.localeCompare(b.at));
  let cum = 0;
  let realizedToday = 0;
  let feesAllTime = 0;
  let feesToday = 0;
  for (const f of feeEvents) {
    feesAllTime += -f.delta;
    if (input.isToday(f.at)) feesToday += -f.delta;
  }
  let curvePeak = input.budget;
  for (const e of events) {
    cum += e.delta;
    if (input.isToday(e.at)) realizedToday += e.delta;
    curvePeak = Math.max(curvePeak, input.budget + cum);
  }
  let unrealized = 0;
  let unvalued = 0;
  for (const p of input.positions) {
    if (!(Math.abs(p.quantity) > 0)) continue;
    const u = positionUnrealized(p);
    if (u === null) unvalued += 1; else unrealized += u;
  }
  const equity = input.budget + cum + unrealized;
  runningPeak = Math.max(runningPeak ?? equity, curvePeak, equity);
  const peakEquity = runningPeak;
  return {
    budget: input.budget,
    realizedAllTime: cum,
    realizedToday,
    feesAllTime,
    feesToday,
    unrealized,
    unrealizedUnvaluedPositions: unvalued,
    equity,
    dailyLoss: Math.max(0, -(realizedToday + unrealized)),
    peakEquity,
    drawdownPct: peakEquity > 0 ? Math.max(0, (peakEquity - equity) / peakEquity) : 0,
  };
}
