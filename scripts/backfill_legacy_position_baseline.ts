/**
 * ==========================================================
 * Script: backfill_legacy_position_baseline.ts
 *
 * Purpose:
 * One-time, operator-run backfill for the known migration-0082 gap: trades placed before the
 * fill-ledger baseline system existed have position_quantity_before/position_average_price_before
 * = NULL on `trades`, so every derived fill watermark in `fills.position_quantity_after` is also
 * NULL for that scope - checkPositionFillEvidence() correctly fails closed as
 * POSITION_FILL_BASELINE_UNAVAILABLE rather than guessing.
 *
 * This replays the SAME math as the real, reviewed applyPositionFill() (src/server/services/
 * positionFillEvidence.ts) - realized P&L on closing, average-price blending on same-direction
 * adds, flat-on-crossing-zero, sign-preserving inventory - but computes it forward in-memory from
 * a local running (before, basis) pair across the chronological fill list, instead of calling
 * applyPositionFill() itself. applyPositionFill() finds "the prior fill" via the highest fill id
 * in scope excluding the current one, which is only correct when fills are processed in real time
 * as they occur (the true prior fill is always the only other one that exists yet). A backfill
 * replay violates that assumption - every historical fill already exists with its final id before
 * replay starts - so calling it here would silently match the wrong "prior" row. The formulas
 * below are copied verbatim from applyPositionFill(); any change to that function's math should be
 * mirrored here if this script is ever rerun.
 *
 * Scope is restricted to one (symbol, brokerId, environment) tuple per run via --symbol/--broker/
 * --env. Defaults to --dry-run; --commit is required to write.
 *
 * Usage:
 *   npx tsx scripts/backfill_legacy_position_baseline.ts --symbol=OKTA --broker=ibkr_gateway --env=PAPER [--commit]
 *   npx tsx scripts/backfill_legacy_position_baseline.ts --symbol=OKTA --broker=ibkr_gateway --env=PAPER --reset-partial
 *     (undoes a partial seed from a prior failed/interrupted run - clears position_quantity_before/
 *     position_average_price_before back to NULL for this scope only, so a clean retry can start over)
 * ==========================================================
 */
import 'dotenv/config';
import { sqliteDb } from '../src/server/db';
import { tradingSafety } from '../src/server/config/tradingSafety';

function arg(name: string): string | undefined {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : undefined;
}

const symbol = arg('symbol');
const brokerId = arg('broker');
const environment = arg('env');
const COMMIT = process.argv.includes('--commit');
const RESET = process.argv.includes('--reset-partial');
const tolerance = tradingSafety.reconQtyTolerance;

if (!symbol || !brokerId || !environment) {
  console.error('Usage: --symbol=X --broker=Y --env=Z [--commit|--reset-partial]');
  process.exit(1);
}

function main() {
  if (RESET) {
    const ids = (sqliteDb.prepare(
      `SELECT id FROM trades WHERE symbol=? AND broker_id=? AND execution_environment=?`
    ).all(symbol, brokerId, environment) as any[]).map((r) => r.id);
    for (const id of ids) {
      sqliteDb.prepare(`UPDATE trades SET position_quantity_before=NULL, position_average_price_before=NULL WHERE id=?`).run(id);
      sqliteDb.prepare(`UPDATE fills SET position_quantity_after=NULL, position_average_price_after=NULL, realized_pnl=NULL WHERE order_id=?`).run(id);
    }
    console.log(`Reset ${ids.length} trade(s)/their fills back to NULL baseline for ${symbol}/${brokerId}/${environment}.`);
    return;
  }

  const trades = sqliteDb.prepare(
    `SELECT id, side, quantity, price, timestamp, position_quantity_before, position_average_price_before
     FROM trades WHERE symbol=? AND broker_id=? AND execution_environment=? AND status='FILLED'
     ORDER BY timestamp ASC`
  ).all(symbol, brokerId, environment) as any[];

  if (trades.length === 0) {
    console.log(`No FILLED trades found for ${symbol}/${brokerId}/${environment}.`);
    return;
  }

  const alreadyBaselined = trades.filter((t) => t.position_quantity_before !== null);
  if (alreadyBaselined.length > 0) {
    console.log(`${alreadyBaselined.length} of ${trades.length} trade(s) already have a baseline. Run with --reset-partial first if this is a retry after a failed attempt, then re-run without flags (dry-run) to confirm a clean slate.`);
    return;
  }

  console.log(`Found ${trades.length} un-baselined FILLED trade(s) for ${symbol}/${brokerId}/${environment}, oldest first:`);
  for (const t of trades) console.log(`  ${t.id} ${t.side} ${t.quantity} @ ${t.price} (${t.timestamp})`);

  let before = 0;
  let basis = 0;
  console.log(`\nSeed: starting from flat (0 qty, $0 basis) - first-ever fill in this scope, a known fact not an assumption.`);

  if (COMMIT) {
    sqliteDb.prepare(`UPDATE trades SET position_quantity_before=0, position_average_price_before=0 WHERE id=?`).run(trades[0].id);
  }

  for (const t of trades) {
    const fills = sqliteDb.prepare(`SELECT id, cumulative_quantity, quantity, price FROM fills WHERE order_id=? ORDER BY id ASC`).all(t.id) as any[];
    for (const f of fills) {
      const newQty: number = f.quantity;
      const price: number = f.price;
      const delta = t.side === 'BUY' ? newQty : -newQty;
      const closing = before * delta < 0 ? Math.min(Math.abs(before), newQty) : 0;
      const realized = closing > 0 ? (price - basis) * closing * Math.sign(before) : null;
      const rawAfter = before + delta;
      const after = Math.abs(rawAfter) <= tolerance ? 0 : rawAfter;
      const average = Math.abs(after) <= tolerance ? 0
        : before * after < 0 || before === 0 ? price
        : before * delta > 0 ? (Math.abs(before) * basis + newQty * price) / Math.abs(after) : basis;

      console.log(`  fill ${f.id} (${t.side} ${newQty} @ ${price}): before=${before}@${basis} -> after=${after}@${average}, realized=${realized} [commit=${COMMIT}]`);

      if (COMMIT) {
        sqliteDb.prepare(`UPDATE fills SET position_quantity_after=?, position_average_price_after=?, realized_pnl=? WHERE id=?`)
          .run(after, average, realized, f.id);
      }
      before = after;
      basis = average;
    }
  }

  if (COMMIT) {
    if (Math.abs(before) <= tolerance) {
      sqliteDb.prepare('DELETE FROM portfolio WHERE symbol=?').run(symbol);
    } else {
      sqliteDb.prepare(`INSERT INTO portfolio(symbol,quantity,average_price,current_price,last_updated,broker_source)
        VALUES(?,?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET quantity=excluded.quantity,
        average_price=excluded.average_price,last_updated=excluded.last_updated,broker_source=excluded.broker_source`)
        .run(symbol, before, basis, null, new Date().toISOString(), brokerId);
    }
    console.log(`\nCOMMITTED. Final derived position for ${symbol}: quantity=${before}, averagePrice=${basis}`);
  } else {
    console.log(`\n[DRY RUN] No writes made. Re-run with --commit to apply.`);
  }
}

main();
