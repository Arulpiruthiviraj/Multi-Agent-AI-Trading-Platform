/**
 * ledgerAdapter.ts - reads an ISOLATED synthetic session DB (read-only) and a broker summary into the oracle's input shapes.
 * Only touches the raw facts (fills joined to their trade row); it does not use Argus's own accounting helpers.
 */
import Database from 'better-sqlite3';
import type { LedgerView, OracleFill } from './accountingOracle';

export interface BrokerSummaryLike {
  cash: number; realizedPnl: number; feesPaid: number;
  positions: Array<{ symbol: string; quantity: number; entryPrice?: number; averagePrice?: number; avgPrice?: number }>;
}

export function readOracleInputs(
  dbPath: string,
  broker: BrokerSummaryLike,
  initialCash: number,
  feeForFill: (f: { symbol: string; side: 'BUY' | 'SELL'; quantity: number; price: number }) => number,
): { fills: OracleFill[]; ledger: LedgerView } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT f.id AS fid, f.order_id AS orderId, f.quantity AS quantity, f.price AS price, f.realized_pnl AS realized, t.symbol AS symbol, t.side AS side
         FROM fills f JOIN trades t ON t.id = f.order_id ORDER BY f.filled_at ASC, f.id ASC`,
    ).all() as Array<{ fid: number; orderId: string; quantity: number; price: number; realized: number | null; symbol: string; side: 'BUY' | 'SELL' }>;
    const fills: OracleFill[] = rows.map((r) => ({
      orderId: r.orderId, symbol: r.symbol, side: r.side, quantity: r.quantity, price: r.price,
      feeUsd: feeForFill({ symbol: r.symbol, side: r.side, quantity: r.quantity, price: r.price }),
    }));
    const tradesPnl: Record<string, number | null> = {};
    const fillsRealized: Record<string, number | null> = {};
    for (const t of db.prepare(`SELECT id, profit_loss AS pnl FROM trades WHERE side='SELL' AND status='FILLED'`).all() as Array<{ id: string; pnl: number | null }>) tradesPnl[t.id] = t.pnl;
    for (const r of rows) {
      if (r.side !== 'SELL') continue;
      const prev = fillsRealized[r.orderId];
      fillsRealized[r.orderId] = r.realized === null ? (prev ?? null) : (prev ?? 0) + r.realized;
    }
    const portfolio = (db.prepare(`SELECT symbol, quantity, average_price AS averagePrice FROM portfolio WHERE quantity <> 0`).all() as Array<{ symbol: string; quantity: number; averagePrice: number }>);
    return {
      fills,
      ledger: {
        tradesPnlBySellOrder: tradesPnl,
        fillsRealizedByOrder: fillsRealized,
        portfolio,
        broker: {
          cash: broker.cash, realizedPnl: broker.realizedPnl, feesPaid: broker.feesPaid,
          positions: broker.positions.map((p) => ({ symbol: p.symbol, quantity: p.quantity, entryPrice: p.entryPrice ?? p.averagePrice ?? p.avgPrice ?? 0 })),
        },
        initialCash,
      },
    };
  } finally { db.close(); }
}
