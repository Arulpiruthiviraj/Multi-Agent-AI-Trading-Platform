/**
 * ==========================================================
 * Script: backfill_legacy_position_baseline.ts
 *
 * Purpose:
 * One-time, operator-run backfill for the known migration-0082 gap: trades placed before the
 * fill-ledger baseline system existed have position_quantity_before/position_average_price_before
 * = NULL on `trades`, so every derived fill watermark in `fills.position_quantity_after` is also
 * NULL for that scope - checkPositionFillEvidence() correctly fails closed as
 * POSITION_FILL_BASELINE_UNAVAILABLE rather than guessing. This script seeds the one legitimately
 * known fact - a symbol's very first-ever fill in a given (symbol, broker, environment) scope
 * started from flat (0 qty, $0 basis) - onto that first trade row, then REPLAYS the real,
 * unmodified applyPositionFill() forward through every subsequent fill in chronological order.
 * It does not hand-compute or invent any derived number; the existing, already-reviewed function
 * computes the same chain production would have computed had the baseline existed at the time.
 *
 * Scope is restricted to one (symbol, brokerId, environment) tuple per run via --symbol/--broker/
 * --env, specifically to avoid a sweeping, unreviewed backfill across the whole trade history in
 * one shot. Defaults to --dry-run; --commit is required to write.
 *
 * Usage:
 *   npx tsx scripts/backfill_legacy_position_baseline.ts --symbol=OKTA --broker=ibkr_gateway --env=PAPER [--commit]
 * ==========================================================
 */
import 'dotenv/config';
import { sqliteDb } from '../src/server/db';
import { applyPositionFill } from '../src/server/services/positionFillEvidence';

function arg(name: string): string | undefined {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : undefined;
}

const symbol = arg('symbol');
const brokerId = arg('broker');
const environment = arg('env');
const COMMIT = process.argv.includes('--commit');

if (!symbol || !brokerId || !environment) {
  console.error('Usage: --symbol=X --broker=Y --env=Z [--commit]');
  process.exit(1);
}

function main() {
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
    console.log(`${alreadyBaselined.length} of ${trades.length} trade(s) already have a baseline - refusing to touch an already-seeded scope. Investigate before proceeding.`);
    return;
  }

  console.log(`Found ${trades.length} un-baselined FILLED trade(s) for ${symbol}/${brokerId}/${environment}, oldest first:`);
  for (const t of trades) console.log(`  ${t.id} ${t.side} ${t.quantity} @ ${t.price} (${t.timestamp})`);

  console.log(`\nSeeding first trade (${trades[0].id}) with position_quantity_before=0, position_average_price_before=0 (first-ever fill in this scope - a real, known fact, not an assumption).`);

  if (COMMIT) {
    sqliteDb.prepare(`UPDATE trades SET position_quantity_before=0, position_average_price_before=0 WHERE id=?`).run(trades[0].id);
  }

  for (const t of trades) {
    const fills = sqliteDb.prepare(`SELECT cumulative_quantity, quantity, price FROM fills WHERE order_id=? ORDER BY id ASC`).all(t.id) as any[];
    for (const f of fills) {
      console.log(`  replaying applyPositionFill(${t.id}, qty=${f.quantity}, price=${f.price}, cumQty=${f.cumulative_quantity}) [commit=${COMMIT}]`);
      if (COMMIT) {
        const ok = applyPositionFill(t.id, f.quantity, f.price, f.cumulative_quantity);
        if (!ok) {
          console.error(`  applyPositionFill returned false for ${t.id} - stopping, chain is now inconsistent. Investigate before retrying.`);
          process.exit(1);
        }
      }
    }
  }

  const after = sqliteDb.prepare(
    `SELECT f.position_quantity_after AS quantity, f.position_average_price_after AS averagePrice, f.realized_pnl
     FROM fills f JOIN trades t ON t.id=f.order_id WHERE t.symbol=? AND t.broker_id=? AND t.execution_environment=?
     ORDER BY f.id DESC LIMIT 1`
  ).get(symbol, brokerId, environment) as any;

  if (COMMIT) {
    console.log(`\nCOMMITTED. Resulting latest fill watermark for ${symbol}:`, after);
  } else {
    console.log(`\n[DRY RUN] No writes made. Re-run with --commit to apply. Expected final watermark will match the real historical fill chain (quantity/avgPrice as computed by the unmodified applyPositionFill()) - re-run with --commit then re-query to see the real computed result rather than a hand-predicted one.`);
  }
}

main();
