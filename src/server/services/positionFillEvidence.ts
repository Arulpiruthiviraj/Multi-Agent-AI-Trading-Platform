/** Inventory evidence in the existing order/fill ledger, not a second position source.
 * Unknown/unversioned broker quantities may confirm a fill watermark, never supersede it.
 * Portfolio accounting stays in Node's synchronous SQLite transaction (not quant logic).
 */
import { sqliteDb } from '../db';
import { tradingSafety } from '../config/tradingSafety';

type Scope = { symbol: string; brokerId: string; environment: string };
type Watermark = { id: number; quantity: number | null; averagePrice: number | null };
const tolerance = tradingSafety.reconQtyTolerance;

export function latestPositionFill(scope: Scope): Watermark | undefined {
  return sqliteDb.prepare(`SELECT f.id, f.position_quantity_after AS quantity,
    f.position_average_price_after AS averagePrice FROM fills f JOIN trades t ON t.id=f.order_id
    WHERE t.symbol=? AND t.broker_id=? AND t.execution_environment=? ORDER BY f.id DESC LIMIT 1`)
    .get(scope.symbol, scope.brokerId, scope.environment) as Watermark | undefined;
}

export function checkPositionFillEvidence(scope: Scope, remoteQuantity: number): string | null {
  if (!Number.isFinite(remoteQuantity)) return 'POSITION_QUANTITY_UNAVAILABLE';
  const fill = latestPositionFill(scope);
  if (!fill) return null;
  if (fill.quantity === null) return 'POSITION_FILL_BASELINE_UNAVAILABLE';
  return Math.abs(fill.quantity - remoteQuantity) > tolerance ? 'POSITION_FILL_CONFLICT' : null;
}

/** Distinct symbols this (broker, environment) scope has ANY fill-ledger history for. Used to
 * cross-check a symbol the broker currently reports as flat/absent against the authoritative
 * fill ledger, even when the `portfolio` cache table never hydrated it (e.g. a short position -
 * see PortfolioReconciliation.ts's short-position branch). Without this, a symbol missing from
 * BOTH the broker response AND the local cache is invisible to every existing comparison loop,
 * so a genuine broker/ledger disagreement (broker says flat, ledger says a real position) would
 * never surface at all. 2026-10-06, ARGUS_SHORT_RECONCILIATION_SEMANTICS_FIX.
 */
export function listSymbolsWithFillLedgerHistory(brokerId: string, environment: string): string[] {
  const rows = sqliteDb.prepare(`SELECT DISTINCT t.symbol AS symbol FROM fills f
    JOIN trades t ON t.id = f.order_id
    WHERE t.broker_id = ? AND t.execution_environment = ?`).all(brokerId, environment) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol).filter(Boolean);
}

/** Called after broker read, directly before placeOrder. The already-persisted PENDING row is
 * the reservation. Sibling unresolved orders are rejected, not timed out or assumed canceled.
 * Validation + baseline write are synchronous so two independent exit traces cannot race.
 */
export function prepareOrderPosition(orderId: string, remote: { quantity: number; entryPrice: number }): string | null {
  return sqliteDb.transaction(() => {
    const order = sqliteDb.prepare('SELECT * FROM trades WHERE id=?').get(orderId) as any;
    if (!order?.broker_id || !order.execution_environment) return 'POSITION_SCOPE_UNAVAILABLE';
    const scope = { symbol: order.symbol, brokerId: order.broker_id, environment: order.execution_environment };
    const conflict = checkPositionFillEvidence(scope, remote.quantity);
    if (conflict) return conflict;
    // Old orders with ambiguous submission/fill state continue to reserve the symbol after restart.
    // 2026-10-08 defect hunt (D2): this check had NO age bound. After an InternalPaperBroker
    // restart (in-memory orders lost), followUpOpenOrders gives up after 30 min and
    // reconcileStaleOrders only covers the 48h crash-recovery lookback - but the row stayed
    // PENDING forever and this check then refused every future order for the symbol, a
    // permanent silent per-symbol trading halt. Bound the check to the same lookback the
    // recovery paths use: a row older than crashRecoveryLookbackMs is definitively beyond
    // every recovery window, so it must not reserve the symbol. NULL submitted_at (legacy
    // rows) still blocks - unknown age fails closed.
    const recoveryCutoffIso = new Date(Date.now() - tradingSafety.crashRecoveryLookbackMs).toISOString();
    const pending = sqliteDb.prepare(`SELECT id FROM trades WHERE symbol=? AND broker_id=?
      AND execution_environment=? AND id<>? AND status NOT IN
      ('FILLED','REJECTED','CANCELED','EXTERNAL_MANUAL','ARCHIVED_DIAGNOSTIC')
      AND (submitted_at IS NULL OR submitted_at >= ?) LIMIT 1`)
      .get(order.symbol, order.broker_id, order.execution_environment, orderId, recoveryCutoffIso);
    if (pending) return 'POSITION_ORDER_UNRESOLVED';
    const fill = latestPositionFill(scope);
    const local = sqliteDb.prepare('SELECT quantity, average_price, broker_source FROM portfolio WHERE symbol=?')
      .get(order.symbol) as any;
    const quantity = fill ? fill.quantity! : (local?.quantity ?? 0);
    if (Math.abs(quantity - remote.quantity) > tolerance
      || (local && local.broker_source !== order.broker_id)) return 'POSITION_BASELINE_UNCONFIRMED';
    if (!Number.isFinite(order.quantity) || order.quantity <= 0) return 'POSITION_INVALID_ORDER_QUANTITY';
    // Production SELL means CLOSE_LONG. OPEN_SHORT has no authorized production order path.
    if (order.side === 'SELL' && (quantity <= 0 || order.quantity > quantity + tolerance)) {
      return 'CLOSE_LONG_QUANTITY_EXCEEDED';
    }
    if (order.side !== 'BUY' && order.side !== 'SELL') return 'POSITION_INVALID_SIDE';
    const averagePrice = fill ? fill.averagePrice : (local?.average_price ?? 0);
    if (quantity !== 0 && !(Number.isFinite(averagePrice) && averagePrice! > 0)) return 'POSITION_BASIS_UNAVAILABLE';
    sqliteDb.prepare('UPDATE trades SET position_quantity_before=?, position_average_price_before=? WHERE id=?')
      .run(quantity, averagePrice ?? 0, orderId);
    return null;
  }).immediate();
}

/** Must run INSIDE insertIncrementalFill's IMMEDIATE transaction. Atomically updates the fill
 * watermark, local inventory and gross realized P&L. A crash can apply all of them or none.
 * Signed inventory records unexpected broker overfills honestly; it never turns them into profit.
 */
export function applyPositionFill(orderId: string, newQty: number, price: number, cumulativeQuantity: number): boolean {
  const order = sqliteDb.prepare('SELECT * FROM trades WHERE id=?').get(orderId) as any;
  if (!order?.broker_id || !order.execution_environment
    || order.position_quantity_before === null || order.position_average_price_before === null) return false;
  // Use the latest scoped inventory, not this order's old baseline: a late fill after cancellation
  // can arrive after a newer order. It must add to current signed inventory rather than reset it.
  const prior = sqliteDb.prepare(`SELECT f.position_quantity_after AS quantity, f.position_average_price_after AS averagePrice
    FROM fills f JOIN trades t ON t.id=f.order_id WHERE t.symbol=? AND t.broker_id=?
    AND t.execution_environment=? AND NOT(f.order_id=? AND f.cumulative_quantity=?) ORDER BY f.id DESC LIMIT 1`)
    .get(order.symbol, order.broker_id, order.execution_environment, orderId, cumulativeQuantity) as any;
  if (prior && (prior.quantity === null || prior.averagePrice === null)) return false;
  const before = prior?.quantity ?? order.position_quantity_before;
  const basis = prior?.averagePrice ?? order.position_average_price_before;
  const delta = order.side === 'BUY' ? newQty : -newQty;
  const closing = before * delta < 0 ? Math.min(Math.abs(before), newQty) : 0;
  const realized = closing > 0 ? (price - basis) * closing * Math.sign(before) : null;
  const rawAfter = before + delta;
  const after = Math.abs(rawAfter) <= tolerance ? 0 : rawAfter;
  const average = Math.abs(after) <= tolerance ? 0
    : before * after < 0 || before === 0 ? price
    : before * delta > 0 ? (Math.abs(before) * basis + newQty * price) / Math.abs(after) : basis;
  sqliteDb.prepare(`UPDATE fills SET position_quantity_after=?, position_average_price_after=?, realized_pnl=?
    WHERE order_id=? AND cumulative_quantity=?`).run(after, average, realized, orderId, cumulativeQuantity);
  if (Math.abs(after) <= tolerance) {
    sqliteDb.prepare('DELETE FROM portfolio WHERE symbol=?').run(order.symbol);
  } else {
    sqliteDb.prepare(`INSERT INTO portfolio(symbol,quantity,average_price,current_price,last_updated,broker_source)
      VALUES(?,?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET quantity=excluded.quantity,
      average_price=excluded.average_price,current_price=excluded.current_price,last_updated=excluded.last_updated,
      broker_source=excluded.broker_source`).run(order.symbol, after, average, price, new Date().toISOString(), order.broker_id);
  }
  sqliteDb.prepare(`UPDATE trades SET profit_loss=(SELECT SUM(realized_pnl) FROM fills WHERE order_id=?) WHERE id=?`)
    .run(orderId, orderId);
  return true;
}
