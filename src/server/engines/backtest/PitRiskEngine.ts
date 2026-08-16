/**
 * Point-in-time RiskEngine wrapper for historical replay.
 *
 * Does not call live RiskEngine.evaluateRisk() (that reads the live broker, live clock,
 * and writes risk_assessments). It evaluates the same named gates, in the same order,
 * against simulated PIT state so a backtest BUY that would have been vetoed live is vetoed here.
 */
import { INVALID_ACCOUNT_EQUITY, isPositiveFiniteMoney } from '../AccountEquity';
import { snapshotCapital, evaluateAllocationGuard } from '../CapitalAllocation';
import { evaluateDailyBuyNotional, resolveDailyBuyNotionalCap, sumDailyBuyNotional } from '../DailyBuyNotional';
import { calculatePositionSizing } from '../PositionSizing';
import { getTradingDateStr } from '../../core/TradingCalendar';
import { tradingSafety } from '../../config/tradingSafety';
import { newsImpactOnVetoScale } from '../../news/newsClusterMatch';
import {
  consecutiveLossBlocksNewBuys,
  dailyLossBlocksNewBuys,
  drawdownBlocksNewBuys,
  marketHoursBlocksNewBuys,
  orderRateBlocksNewBuys,
} from './BacktestRiskParity';

export interface PitNewsHit {
  symbol: string;
  impactScore: number | null;
  publishedAtMs: number;
}

export interface PitRiskContext {
  nowMs: number;
  timeframe: string;
  tradingState: 'TRADING_ENABLED' | 'TRADING_PAUSED' | 'EMERGENCY_STOP';
  side: 'BUY' | 'SELL';
  symbol: string;
  currentPrice: number;
  equityNow: number;
  buyingPower: number;
  dayStartEquity: number;
  dailyLossLimitDollars: number;
  peakEquity: number;
  maxPortfolioDrawdownPct: number;
  recentClosedPnlsNewestFirst: number[];
  buyTimestampsMs: number[];
  maxOrdersPerMinute: number;
  existingPositions: Array<{ symbol: string; quantity: number; averagePrice?: number }>;
  maxTradeSizeDollar: number;
  maxPortfolioRiskPct: number;
  maxOpenPositions: number;
  sizingMode?: 'FIXED_DOLLAR' | 'PERCENT_OF_EQUITY';
  percentOfEquityPct?: number;
  allocatedBudget: number;
  tradingMode: string;
  dailyBuyRows: Array<{ side?: string; status?: string; price?: number; quantity?: number; timestamp?: string }>;
  getRecentCloses: (symbol: string) => Promise<number[] | null>;
  pitNews: PitNewsHit[];
  barTimestampMs: number;
}

export interface PitGateResult {
  gate: string;
  passed: boolean;
  detail: any;
}

export interface PitRiskResult {
  approved: boolean;
  maxQuantity: number;
  rejectionGate: string | null;
  reasoning: string;
  gateResults: PitGateResult[];
}

export async function evaluatePitRisk(ctx: PitRiskContext): Promise<PitRiskResult> {
  const gateResults: PitGateResult[] = [];
  const record = (gate: string, passed: boolean, detail: any) => gateResults.push({ gate, passed, detail });
  let maxQuantity = 0;

  const emergencyPassed = ctx.tradingState === 'TRADING_ENABLED';
  record('emergency_stop', emergencyPassed, { tradingState: ctx.tradingState });

  if (!isPositiveFiniteMoney(ctx.equityNow)) {
    record(INVALID_ACCOUNT_EQUITY, false, { equity: ctx.equityNow });
  } else {
    record(INVALID_ACCOUNT_EQUITY, true, { equity: ctx.equityNow });
  }

  const dailyLossTriggered = dailyLossBlocksNewBuys({
    equityNow: ctx.equityNow,
    dayStartEquity: ctx.dayStartEquity,
    dailyLossLimitDollars: ctx.dailyLossLimitDollars,
  });
  record('daily_loss', !dailyLossTriggered, {
    equityNow: ctx.equityNow,
    dayStartEquity: ctx.dayStartEquity,
    dailyLossLimitDollars: ctx.dailyLossLimitDollars,
  });

  const consecutiveTriggered = consecutiveLossBlocksNewBuys(ctx.recentClosedPnlsNewestFirst);
  record('consecutive_loss', !consecutiveTriggered, {
    maxConsecutiveLosses: tradingSafety.maxConsecutiveLosses,
    triggered: consecutiveTriggered,
  });

  const drawdownTriggered = drawdownBlocksNewBuys({
    equityNow: ctx.equityNow,
    peakEquity: ctx.peakEquity,
    maxPortfolioDrawdownPct: ctx.maxPortfolioDrawdownPct,
  });
  record('portfolio_drawdown', !drawdownTriggered, {
    equityNow: ctx.equityNow,
    peakEquity: ctx.peakEquity,
    maxPortfolioDrawdownPct: ctx.maxPortfolioDrawdownPct,
  });

  const rateTriggered = orderRateBlocksNewBuys({
    buyTimestampsMs: ctx.buyTimestampsMs,
    nowMs: ctx.nowMs,
    maxOrdersPerMinute: ctx.maxOrdersPerMinute,
  });
  record('order_rate_limit', !rateTriggered, {
    recentBuys: ctx.buyTimestampsMs.filter(t => ctx.nowMs - t < 60_000).length,
    maxOrdersPerMinute: ctx.maxOrdersPerMinute,
  });

  const hoursBlocked = marketHoursBlocksNewBuys(ctx.nowMs, ctx.timeframe);
  record('market_hours', !hoursBlocked, { nowMs: ctx.nowMs, timeframe: ctx.timeframe, failClosed: true });

  const priceAgeMs = ctx.nowMs - ctx.barTimestampMs;
  const stale = priceAgeMs > tradingSafety.stalePriceThresholdMs;
  record('data_freshness', !stale, { priceAgeMs, thresholdMs: tradingSafety.stalePriceThresholdMs });

  const newsHits = ctx.pitNews.filter(n =>
    n.symbol === ctx.symbol
    && typeof n.impactScore === 'number'
    && newsImpactOnVetoScale(n.impactScore) > tradingSafety.newsVetoMinImpactScore
    && n.publishedAtMs <= ctx.nowMs
    && n.publishedAtMs >= ctx.nowMs - tradingSafety.newsVetoWindowMs,
  );
  record('news_veto', newsHits.length === 0, { matchingClusters: newsHits.length, skipped: ctx.pitNews.length === 0 });

  const priceValid = isPositiveFiniteMoney(ctx.currentPrice);
  record('price_validity', priceValid, { currentPrice: ctx.currentPrice });

  if (priceValid && isPositiveFiniteMoney(ctx.equityNow)) {
    const sizing = await calculatePositionSizing({
      side: ctx.side,
      symbol: ctx.symbol,
      currentPrice: ctx.currentPrice,
      accountEquity: ctx.equityNow,
      buyingPower: ctx.buyingPower,
      maxTradeSizeDollar: ctx.maxTradeSizeDollar,
      maxPortfolioRiskPct: ctx.maxPortfolioRiskPct,
      existingPositions: ctx.existingPositions.map(p => ({ symbol: p.symbol, quantity: p.quantity })),
      maxOpenPositions: ctx.maxOpenPositions,
      getRecentCloses: ctx.getRecentCloses,
      sizingMode: ctx.sizingMode,
      percentOfEquityPct: ctx.percentOfEquityPct,
    });
    maxQuantity = sizing.maxQuantity;
    for (const g of sizing.gates) record(g.gate, g.passed, g.detail);

    if (ctx.side === 'SELL') {
      const existing = ctx.existingPositions.find(p => p.symbol === ctx.symbol);
      const sellOk = !!existing && existing.quantity > 0;
      record('sell_position_exists', sellOk, { existingQuantity: existing?.quantity ?? 0 });
      if (sellOk) maxQuantity = Math.min(maxQuantity, existing!.quantity);
    }

    const capitalSnap = snapshotCapital({
      allocated: ctx.allocatedBudget,
      positions: ctx.existingPositions,
      pendingBuys: [],
    });
    const requestedNotional = ctx.side === 'BUY' ? maxQuantity * ctx.currentPrice : 0;
    const capitalGuard = evaluateAllocationGuard(capitalSnap, ctx.side, requestedNotional);
    record('argus_capital_allocation', capitalGuard.passed, capitalGuard);

    const dailyCap = resolveDailyBuyNotionalCap(ctx.tradingMode);
    const alreadyToday = sumDailyBuyNotional(ctx.dailyBuyRows, getTradingDateStr(new Date(ctx.nowMs)));
    const dailyGuard = evaluateDailyBuyNotional({
      cap: dailyCap,
      side: ctx.side,
      alreadyDeployed: alreadyToday,
      requestedNotional,
    });
    record('daily_buy_notional', dailyGuard.passed, dailyGuard);
  } else {
    record('sufficient_size', false, { skipped: true, reason: 'invalid price or equity - sizing not evaluated' });
    record('argus_capital_allocation', false, { skipped: true });
    record('daily_buy_notional', false, { skipped: true });
  }

  const firstFailure = gateResults.find(g => !g.passed);
  const approved = !firstFailure;
  if (!approved) maxQuantity = 0;
  return {
    approved,
    maxQuantity,
    rejectionGate: firstFailure?.gate ?? null,
    reasoning: approved
      ? 'PIT RiskEngine approved (same gate ladder as live, simulated state).'
      : `Rejected by gate: ${firstFailure!.gate}`,
    gateResults,
  };
}
