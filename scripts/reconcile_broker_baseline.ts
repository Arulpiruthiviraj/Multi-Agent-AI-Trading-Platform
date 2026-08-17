/**
 * ==========================================================
 * Script: reconcile_broker_baseline.ts
 *
 * Purpose:
 * One-time, operator-run baseline sync for a broker account that already holds real positions
 * Argus never opened (e.g. placed manually, or predating this environment's own order tracking).
 * PortfolioReconciliation.ts correctly refuses to silently ignore these - this script is the
 * sanctioned way to adopt them into Argus's own records instead, WITHOUT bypassing RiskEngine,
 * OMS, or fabricating an organic paper trade.
 *
 * Real, not fabricated: quantity/entry price/current price all come directly from the broker's
 * own real portfolio() call - nothing here is invented. `execution_environment` is stamped
 * 'EXTERNAL_SYNC' (not 'PAPER'), so organicPaper.ts's isOrganicClosedPaper() - which requires
 * classifyTradeEnvironment(row) === 'PAPER' - can never count these as organic Argus trading
 * activity, now or later.
 *
 * Usage: npx tsx scripts/reconcile_broker_baseline.ts [--dry-run]
 * ==========================================================
 */
import 'dotenv/config';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../src/server/db';
import * as schema from '../src/server/db/schema';
import { BrokerManager } from '../src/brokers/BrokerManager';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  await BrokerManager.getInstance().initialize();
  const broker = BrokerManager.getInstance().getActiveBroker();
  console.log(`Active broker: ${broker.name}`);

  // Match PortfolioReconciliation.ts's own real comparison (trades.brokerOrderId against every
  // real broker FILLED order) - not the aggregated portfolio() snapshot, which this session
  // already found can look "synced" while the underlying order history is still missing locally.
  const brokerOrders = await broker.orders();
  const localTrades = await db.select().from(schema.trades);
  const localBrokerOrderIds = new Set(localTrades.map((t) => t.brokerOrderId).filter((id): id is string => !!id));

  const portfolio = await broker.portfolio();
  const positionBySymbol = new Map(portfolio.positions.map((p) => [p.symbol, p]));

  const adopted: Array<{ symbol: string; quantity: number; price: number }> = [];

  for (const order of brokerOrders.filter((o) => o.status === 'FILLED')) {
    if (localBrokerOrderIds.has(order.id)) continue; // already tracked locally
    const qty = order.filledQuantity || order.quantity;
    const price = order.averageFillPrice || order.price;
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || (price as number) <= 0) continue;

    adopted.push({ symbol: order.symbol, quantity: qty, price: price as number });

    if (DRY_RUN) continue;

    const now = new Date().toISOString();
    await db.insert(schema.trades).values({
      id: crypto.randomUUID(),
      symbol: order.symbol,
      side: order.side,
      quantity: qty,
      price: price as number,
      status: 'FILLED',
      timestamp: order.updatedAt?.toISOString?.() ?? now,
      filledAt: order.updatedAt?.toISOString?.() ?? now,
      reasoning: `Imported during manual baseline reconciliation - real pre-existing ${broker.name} order, not an Argus-originated decision.`,
      traceId: `baseline-sync-${Date.now()}-${order.symbol}`,
      brokerOrderId: order.id,
      executionEnvironment: 'EXTERNAL_SYNC', // deliberately NOT 'PAPER' - excluded from organic paper stats by design
    } as any);

    // Keep the local portfolio snapshot honest too, in case this order predates it as well.
    const pos = positionBySymbol.get(order.symbol);
    if (pos && !DRY_RUN) {
      const existing = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, order.symbol));
      if (existing.length === 0) {
        await db.insert(schema.portfolio).values({
          symbol: pos.symbol,
          quantity: pos.quantity,
          averagePrice: pos.entryPrice,
          currentPrice: pos.currentPrice,
          lastUpdated: now,
          unrealizedPnL: pos.unrealizedPnl,
          brokerSource: broker.name,
          currency: 'USD',
        });
      }
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] Would adopt' : 'Adopted'} ${adopted.length} untracked broker FILLED order(s):`);
  for (const a of adopted) {
    console.log(`  ${a.symbol}: ${a.quantity} @ $${a.price.toFixed(2)}`);
  }
  if (adopted.length === 0) {
    console.log('  (none - local trades already has a row for every real broker FILLED order)');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
