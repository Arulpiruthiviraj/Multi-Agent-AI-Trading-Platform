/**
 * accountingOracle.ts - an INDEPENDENT recomputation of positions, average cost, realized P&L, fees and cash from raw fills.
 *
 * Why it exists (certification principle): a session's accounting must never be validated by asking Argus's own accounting what the
 * answer is. This module shares no code with PositionSizing, OrderManagement, the fills ledger, HistoricalReplayBroker or the
 * portfolio table. It consumes only the raw facts of what traded (symbol, side, quantity, price, fee) and derives everything else
 * with the textbook average-cost method, so a ledger bug cannot also be present in the oracle.
 *
 * Pure: no DB, no clock, no randomness. Labeled SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY when fed synthetic sessions.
 */
export interface OracleFill {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  /** Commission charged on this fill in USD (0 if unknown/none). */
  feeUsd?: number;
}

export interface OraclePosition { symbol: string; quantity: number; avgCost: number }

export interface OracleSellRecord { orderId: string; symbol: string; quantity: number; price: number; avgCostAtSale: number; grossPnl: number; feeUsd: number }

export interface OracleResult {
  positions: OraclePosition[];
  sells: OracleSellRecord[];
  grossRealizedPnl: number;
  feesTotal: number;
  /** gross realized P&L minus ALL fees (entry and exit commissions). */
  netRealizedPnl: number;
  /** cash change from the fills alone: -(BUY notional + fee) + (SELL notional - fee). */
  cashDelta: number;
  realizedBySymbol: Record<string, number>;
  violations: Array<{ code: 'OVERSELL' | 'NON_POSITIVE_QUANTITY' | 'NON_POSITIVE_PRICE'; detail: string }>;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function runAccountingOracle(fills: OracleFill[], opts: { allowShort?: boolean } = {}): OracleResult {
  const pos = new Map<string, { qty: number; avg: number }>();
  const sells: OracleSellRecord[] = [];
  const violations: OracleResult['violations'] = [];
  const realizedBySymbol: Record<string, number> = {};
  let gross = 0; let fees = 0; let cash = 0;

  for (const f of fills) {
    if (!(f.quantity > 0)) { violations.push({ code: 'NON_POSITIVE_QUANTITY', detail: `${f.orderId} ${f.symbol} qty=${f.quantity}` }); continue; }
    if (!(f.price > 0)) { violations.push({ code: 'NON_POSITIVE_PRICE', detail: `${f.orderId} ${f.symbol} price=${f.price}` }); continue; }
    const fee = f.feeUsd ?? 0;
    fees += fee;
    const p = pos.get(f.symbol) ?? { qty: 0, avg: 0 };
    if (f.side === 'BUY') {
      cash -= f.quantity * f.price + fee;
      const newQty = p.qty + f.quantity;
      p.avg = newQty === 0 ? 0 : (p.qty * p.avg + f.quantity * f.price) / newQty;
      p.qty = newQty;
    } else {
      cash += f.quantity * f.price - fee;
      if (f.quantity > p.qty + 1e-9 && !opts.allowShort) {
        violations.push({ code: 'OVERSELL', detail: `${f.orderId} ${f.symbol} sells ${f.quantity} with only ${p.qty} held` });
      }
      const closing = Math.min(f.quantity, Math.max(p.qty, 0));
      const pnl = (f.price - p.avg) * closing;
      gross += pnl;
      realizedBySymbol[f.symbol] = (realizedBySymbol[f.symbol] ?? 0) + pnl;
      sells.push({ orderId: f.orderId, symbol: f.symbol, quantity: f.quantity, price: f.price, avgCostAtSale: p.avg, grossPnl: r6(pnl), feeUsd: fee });
      p.qty -= f.quantity;
      if (Math.abs(p.qty) < 1e-9) { p.qty = 0; p.avg = 0; }
    }
    pos.set(f.symbol, p);
  }

  return {
    positions: [...pos.entries()].filter(([, v]) => Math.abs(v.qty) > 1e-9).map(([symbol, v]) => ({ symbol, quantity: v.qty, avgCost: r6(v.avg) })),
    sells,
    grossRealizedPnl: r6(gross),
    feesTotal: r6(fees),
    netRealizedPnl: r6(gross - fees),
    cashDelta: r6(cash),
    realizedBySymbol: Object.fromEntries(Object.entries(realizedBySymbol).map(([k, v]) => [k, r6(v)])),
    violations,
  };
}

export interface LedgerView {
  /** trades.profit_loss keyed by SELL order id (null when the ledger recorded none). */
  tradesPnlBySellOrder: Record<string, number | null>;
  /** fills.realized_pnl keyed by order id. */
  fillsRealizedByOrder: Record<string, number | null>;
  /** Argus portfolio table rows with a non-zero quantity. */
  portfolio: Array<{ symbol: string; quantity: number; averagePrice: number }>;
  /** Simulated broker's own summary (independent bookkeeper #2). */
  broker: { cash: number; realizedPnl: number; feesPaid: number; positions: Array<{ symbol: string; quantity: number; entryPrice: number }> };
  initialCash: number;
}

export interface AccountingMismatch { code: string; detail: string }

/**
 * Compares the independent oracle against every bookkeeper in the system. Tolerances are in USD / shares and are tight on purpose:
 * the oracle and the ledger do the same arithmetic on the same fills, so any visible difference is a bookkeeping defect, not noise.
 */
export function compareOracleToLedger(
  oracle: OracleResult,
  ledger: LedgerView,
  tol: { pnlUsd: number; cashUsd: number; avgCost: number } = { pnlUsd: 0.005, cashUsd: 0.01, avgCost: 1e-4 },
): AccountingMismatch[] {
  const out: AccountingMismatch[] = [];
  for (const v of oracle.violations) out.push({ code: `ORACLE_${v.code}`, detail: v.detail });

  // An order may fill in several pieces (partial fills): trades.profit_loss and the per-order fill P&L are ORDER-level totals, so the oracle's
  // per-fill sells are summed per order before comparing.
  const sellsByOrder = new Map<string, { orderId: string; grossPnl: number }>();
  for (const s of oracle.sells) {
    const cur = sellsByOrder.get(s.orderId);
    if (cur) cur.grossPnl = r6(cur.grossPnl + s.grossPnl); else sellsByOrder.set(s.orderId, { orderId: s.orderId, grossPnl: s.grossPnl });
  }
  for (const s of sellsByOrder.values()) {
    const ledgerPnl = ledger.tradesPnlBySellOrder[s.orderId];
    if (ledgerPnl === undefined) out.push({ code: 'LEDGER_SELL_MISSING', detail: `no trades row for SELL ${s.orderId}` });
    else if (ledgerPnl === null) out.push({ code: 'LEDGER_PNL_NULL', detail: `trades.profit_loss is NULL for filled SELL ${s.orderId} (oracle gross ${s.grossPnl})` });
    else if (Math.abs(ledgerPnl - s.grossPnl) > tol.pnlUsd) out.push({ code: 'LEDGER_PNL_MISMATCH', detail: `SELL ${s.orderId}: trades.profit_loss ${ledgerPnl} vs oracle gross ${s.grossPnl}` });
    const fr = ledger.fillsRealizedByOrder[s.orderId];
    if (fr !== undefined && fr !== null && Math.abs(fr - s.grossPnl) > tol.pnlUsd) out.push({ code: 'FILL_REALIZED_MISMATCH', detail: `SELL ${s.orderId}: fills.realized_pnl ${fr} vs oracle gross ${s.grossPnl}` });
  }

  const byPortfolio = new Map(ledger.portfolio.map((p) => [p.symbol, p]));
  for (const p of oracle.positions) {
    const lp = byPortfolio.get(p.symbol);
    if (!lp) out.push({ code: 'PORTFOLIO_POSITION_MISSING', detail: `${p.symbol}: oracle holds ${p.quantity}, portfolio table has none` });
    else {
      if (Math.abs(lp.quantity - p.quantity) > 1e-9) out.push({ code: 'PORTFOLIO_QUANTITY_MISMATCH', detail: `${p.symbol}: portfolio ${lp.quantity} vs oracle ${p.quantity}` });
      if (Math.abs(lp.averagePrice - p.avgCost) > tol.avgCost) out.push({ code: 'PORTFOLIO_AVG_COST_MISMATCH', detail: `${p.symbol}: portfolio ${lp.averagePrice} vs oracle ${p.avgCost}` });
    }
  }
  for (const lp of ledger.portfolio) {
    if (!oracle.positions.some((p) => p.symbol === lp.symbol)) out.push({ code: 'UNEXPLAINED_PORTFOLIO_POSITION', detail: `${lp.symbol} qty ${lp.quantity} is in the portfolio table but not explained by any fill` });
  }

  const byBroker = new Map(ledger.broker.positions.map((p) => [p.symbol, p]));
  for (const p of oracle.positions) {
    const bp = byBroker.get(p.symbol);
    if (!bp || Math.abs(bp.quantity - p.quantity) > 1e-9) out.push({ code: 'BROKER_POSITION_MISMATCH', detail: `${p.symbol}: broker ${bp?.quantity ?? 0} vs oracle ${p.quantity}` });
  }
  for (const bp of ledger.broker.positions) {
    if (Math.abs(bp.quantity) > 1e-9 && !oracle.positions.some((p) => p.symbol === bp.symbol)) out.push({ code: 'UNEXPLAINED_BROKER_POSITION', detail: `${bp.symbol} qty ${bp.quantity} held at the broker but not explained by any fill` });
  }

  // cash identity: cash = initial + signed notional - fees. This is the strongest single check on the whole fill path.
  const expectedCash = ledger.initialCash + oracle.cashDelta;
  if (Math.abs(ledger.broker.cash - expectedCash) > tol.cashUsd) out.push({ code: 'BROKER_CASH_MISMATCH', detail: `broker cash ${ledger.broker.cash} vs oracle ${r6(expectedCash)} (initial ${ledger.initialCash} + cashDelta ${oracle.cashDelta})` });
  if (Math.abs(ledger.broker.feesPaid - oracle.feesTotal) > tol.cashUsd) out.push({ code: 'BROKER_FEES_MISMATCH', detail: `broker feesPaid ${ledger.broker.feesPaid} vs oracle ${oracle.feesTotal}` });
  // the broker's own realized P&L must lie between gross-minus-all-fees and gross (it nets sell-side fees only, by its own convention)
  if (ledger.broker.realizedPnl > oracle.grossRealizedPnl + tol.pnlUsd || ledger.broker.realizedPnl < oracle.netRealizedPnl - tol.pnlUsd) {
    out.push({ code: 'BROKER_REALIZED_OUT_OF_BOUNDS', detail: `broker realized ${ledger.broker.realizedPnl} outside [${oracle.netRealizedPnl}, ${oracle.grossRealizedPnl}]` });
  }
  return out;
}
