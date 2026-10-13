import Database from 'better-sqlite3';
import type { BuyApproval } from './riskOracle';

/**
 * Reconstructs, for every APPROVED BUY of an isolated synthetic session DB, the raw state the risk oracle needs (holdings from the fills
 * that preceded it, remaining Argus allocation, capital basis, buying power) - from persisted rows only. Policy numbers (percentages,
 * caps) are supplied by the caller from reviewed config / the session's settings row, so the oracle's arithmetic stays independent of
 * PositionSizing. Quantities are compared at the order's recorded arrival price (the price the proposal was sized at).
 */
export interface RiskPolicy {
  maxPortfolioRiskPct: number;
  stopLossAssumptionPct: number;
  maxSingleSymbolConcentrationPct: number;
  maxSectorConcentrationPct: number;
  /** independent sector table owned by the oracle side (symbol -> sector); unknown symbol = null = sector cap not applicable */
  sectorOf: (symbol: string) => string | null;
}

export function readBuyApprovals(dbPath: string, policy: RiskPolicy): BuyApproval[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const settings = db.prepare('SELECT budget, max_trade_size AS maxTradeSize, max_open_positions AS maxOpen FROM settings LIMIT 1').get() as { budget: number; maxTradeSize: number; maxOpen: number };
    const buys = db.prepare(
      `SELECT t.id, t.symbol, t.quantity, t.timestamp, t.arrival_price AS arrival, t.price, t.trace_id AS traceId, ra.account_equity AS equity, ra.buying_power AS bp
         FROM trades t JOIN risk_assessments ra ON ra.transaction_id = t.transaction_id
        WHERE t.side='BUY' AND ra.approved=1 ORDER BY t.timestamp ASC`,
    ).all() as Array<{ id: string; symbol: string; quantity: number; timestamp: string; arrival: number | null; price: number; traceId: string; equity: number; bp: number }>;
    const fills = db.prepare(
      `SELECT f.order_id AS orderId, f.quantity, f.price, f.filled_at AS filledAt, t.symbol, t.side, t.timestamp AS orderAt
         FROM fills f JOIN trades t ON t.id = f.order_id ORDER BY f.filled_at ASC, f.id ASC`,
    ).all() as Array<{ orderId: string; quantity: number; price: number; filledAt: string; symbol: string; side: 'BUY' | 'SELL'; orderAt: string }>;

    return buys.map((b) => {
      const prior = fills.filter((f) => f.filledAt < b.timestamp);
      const lots = new Map<string, { qty: number; cost: number; mark: number }>();
      for (const f of prior) {
        const l = lots.get(f.symbol) ?? { qty: 0, cost: 0, mark: f.price };
        if (f.side === 'BUY') { l.qty += f.quantity; l.cost += f.quantity * f.price; }
        else { const avg = l.qty > 0 ? l.cost / l.qty : 0; l.qty -= f.quantity; l.cost -= avg * f.quantity; }
        l.mark = f.price;
        lots.set(f.symbol, l);
      }
      const held = [...lots.entries()].filter(([, l]) => l.qty > 1e-9);
      const positionCost = held.reduce((s, [, l]) => s + l.cost, 0);
      const pendingNotional = 0; // approvals in these sessions are serialized and filled synchronously; a pending BUY would appear as a trades row without fills
      const price = b.arrival ?? b.price;
      return {
        traceId: b.traceId,
        symbol: b.symbol,
        approvedQuantity: b.quantity,
        input: {
          side: 'BUY' as const,
          symbol: b.symbol,
          price,
          capitalBasis: b.equity,
          maxTradeSizeUsd: settings.maxTradeSize,
          maxPortfolioRiskPct: policy.maxPortfolioRiskPct,
          stopLossAssumptionPct: policy.stopLossAssumptionPct,
          buyingPower: b.bp,
          maxSingleSymbolConcentrationPct: policy.maxSingleSymbolConcentrationPct,
          maxSectorConcentrationPct: policy.maxSectorConcentrationPct,
          maxOpenPositions: settings.maxOpen,
          remainingAllocationUsd: Math.max(0, settings.budget - positionCost - pendingNotional),
          holdings: held.map(([symbol, l]) => ({ symbol, quantity: l.qty, markPrice: l.mark, sector: policy.sectorOf(symbol) })),
          proposalSector: policy.sectorOf(b.symbol),
        },
      };
    });
  } finally { db.close(); }
}
