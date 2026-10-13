/**
 * multiTradeMetrics.ts - measures whether a synthetic session actually exercised a MULTI-TRADE day, from persisted facts only.
 *
 * A session "passes" the multi-trade bar only if it contains ordinary trading variety (several completed round trips, winners AND
 * losers, different sizes, a capital/position-cap rejection, a cooldown rejection, capital reuse after a close) - a single scripted
 * round trip proves one path, not a market day. The bar is a parameter (config-style object) so the same function backs both the
 * KNOWN_OPPORTUNITY_PLATFORM_FIXTURE and exploratory runs. Pure; labeled CERTIFICATION_FIXTURE_ONLY - mechanical capability, not alpha.
 */
export interface MultiTradeInput {
  fills: Array<{ orderId: string; symbol: string; side: 'BUY' | 'SELL'; quantity: number; price: number; feeUsd: number; atMs: number }>;
  riskAssessments: Array<{ side: 'BUY' | 'SELL'; approved: boolean; rejectionGate: string | null; symbol: string; atMs: number }>;
  initialCapital: number;
}

export interface MultiTradeBar {
  minCompletedTrades: number;
  minWinners: number;
  minLosers: number;
  minDistinctEntrySizes: number;
  requireCapitalOrPositionCapRejection: boolean;
  requireCooldownRejection: boolean;
  requireCapitalReuse: boolean;
  requireNetProfitAfterCosts: boolean;
}

export interface RoundTrip { symbol: string; entryAtMs: number; exitAtMs: number; quantity: number; grossPnl: number; feesUsd: number; netPnl: number }

export interface MultiTradeResult {
  roundTrips: RoundTrip[];
  winners: number; losers: number;
  grossPnl: number; feesUsd: number; netPnl: number;
  distinctEntrySizes: number;
  capitalRejections: number; cooldownRejections: number;
  capitalReuseObserved: boolean;
  maxConcurrentExposureUsd: number;
  openLotsAtEnd: number;
  failures: string[];
}

const CAPITAL_GATES = new Set(['argus_capital_allocation', 'open_positions_cap', 'symbol_concentration', 'sector_concentration', 'daily_buy_notional', 'order_notional_cap']);
const COOLDOWN_GATES = new Set(['post_loss_cooldown', 'same_symbol_cooldown']);

export function measureMultiTrade(input: MultiTradeInput, bar: MultiTradeBar): MultiTradeResult {
  const fills = [...input.fills].sort((a, b) => a.atMs - b.atMs);
  // FIFO lots per symbol; a round trip is one fully-closed lot slice (entry fill matched to exit fill).
  const lots = new Map<string, Array<{ qty: number; price: number; fee: number; atMs: number; origQty: number }>>();
  const roundTrips: RoundTrip[] = [];
  const entrySizes = new Set<number>();
  let exposure = 0; let maxExposure = 0;
  const closeTimes: number[] = [];

  for (const f of fills) {
    const q = lots.get(f.symbol) ?? [];
    if (f.side === 'BUY') {
      q.push({ qty: f.quantity, price: f.price, fee: f.feeUsd, atMs: f.atMs, origQty: f.quantity });
      entrySizes.add(f.quantity);
      exposure += f.quantity * f.price;
      maxExposure = Math.max(maxExposure, exposure);
    } else {
      let remaining = f.quantity;
      const exitFeePerShare = f.quantity > 0 ? f.feeUsd / f.quantity : 0;
      while (remaining > 1e-9 && q.length) {
        const lot = q[0];
        const take = Math.min(lot.qty, remaining);
        const entryFee = lot.fee * (take / lot.origQty);
        const gross = (f.price - lot.price) * take;
        const fees = entryFee + exitFeePerShare * take;
        roundTrips.push({ symbol: f.symbol, entryAtMs: lot.atMs, exitAtMs: f.atMs, quantity: take, grossPnl: gross, feesUsd: fees, netPnl: gross - fees });
        exposure -= take * lot.price;
        lot.qty -= take; remaining -= take;
        if (lot.qty <= 1e-9) q.shift();
      }
      closeTimes.push(f.atMs);
    }
    lots.set(f.symbol, q);
  }

  const capRej = input.riskAssessments.filter((r) => r.side === 'BUY' && !r.approved && r.rejectionGate && CAPITAL_GATES.has(r.rejectionGate));
  const coolRej = input.riskAssessments.filter((r) => r.side === 'BUY' && !r.approved && r.rejectionGate && COOLDOWN_GATES.has(r.rejectionGate));
  // capital reuse: a BUY was approved AFTER a position closed and AFTER capital had previously been the binding constraint (or simply
  // a BUY filled after at least one close - the strict form needs a prior capital rejection).
  const firstClose = closeTimes.length ? Math.min(...closeTimes) : Number.POSITIVE_INFINITY;
  const reuse = fills.some((f) => f.side === 'BUY' && f.atMs > firstClose);

  const gross = roundTrips.reduce((s, r) => s + r.grossPnl, 0);
  const fees = roundTrips.reduce((s, r) => s + r.feesUsd, 0);
  const winners = roundTrips.filter((r) => r.netPnl > 0).length;
  const losers = roundTrips.filter((r) => r.netPnl < 0).length;
  const openLots = [...lots.values()].reduce((s, q) => s + q.length, 0);

  const failures: string[] = [];
  if (roundTrips.length < bar.minCompletedTrades) failures.push(`completed trades ${roundTrips.length} < ${bar.minCompletedTrades}`);
  if (winners < bar.minWinners) failures.push(`winners ${winners} < ${bar.minWinners}`);
  if (losers < bar.minLosers) failures.push(`losers ${losers} < ${bar.minLosers}`);
  if (entrySizes.size < bar.minDistinctEntrySizes) failures.push(`distinct entry sizes ${entrySizes.size} < ${bar.minDistinctEntrySizes}`);
  if (bar.requireCapitalOrPositionCapRejection && capRej.length === 0) failures.push('no capital/position-cap rejection observed');
  if (bar.requireCooldownRejection && coolRej.length === 0) failures.push('no cooldown rejection observed');
  if (bar.requireCapitalReuse && !reuse) failures.push('no BUY after a position close (capital reuse not observed)');
  if (bar.requireNetProfitAfterCosts && !(gross - fees > 0)) failures.push(`net P&L after costs ${(gross - fees).toFixed(2)} is not positive`);

  return {
    roundTrips, winners, losers,
    grossPnl: round(gross), feesUsd: round(fees), netPnl: round(gross - fees),
    distinctEntrySizes: entrySizes.size,
    capitalRejections: capRej.length, cooldownRejections: coolRej.length,
    capitalReuseObserved: reuse,
    maxConcurrentExposureUsd: round(maxExposure),
    openLotsAtEnd: openLots,
    failures,
  };
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;
