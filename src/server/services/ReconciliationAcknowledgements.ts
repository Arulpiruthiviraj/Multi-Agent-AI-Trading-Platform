/**
 * Pre-existing broker fill acknowledgements (PRE_EXISTING_RECONCILED).
 *
 * Operator-reviewed only. Does not authorize orders, invent fills, or count as organic paper.
 * PortfolioReconciliation skips acknowledged brokerOrderIds for FILLED_ORDER_MISSING_LOCALLY pause
 * impact; a new unacked orphan still pauses.
 */
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { reconciliationAcknowledgements } from '../db/schema';

export const ACK_STATUS_ACTIVE = 'PRE_EXISTING_RECONCILED';
export const ACK_STATUS_REVOKED = 'REVOKED';

export function reconciliationFingerprint(input: {
  broker: string;
  brokerOrderId: string;
  symbol: string;
  quantity?: number | null;
  averageFillPrice?: number | null;
}): string {
  const raw = [
    input.broker.trim().toLowerCase(),
    input.brokerOrderId.trim(),
    input.symbol.trim().toUpperCase(),
    String(input.quantity ?? ''),
    String(input.averageFillPrice ?? ''),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export async function listActiveAcknowledgements(broker?: string) {
  const rows = await db.select().from(reconciliationAcknowledgements);
  return rows.filter((r) => {
    if (r.status !== ACK_STATUS_ACTIVE) return false;
    if (broker && r.broker !== broker) return false;
    return true;
  });
}

export async function getActiveAcknowledgedOrderIds(broker: string): Promise<Set<string>> {
  const rows = await listActiveAcknowledgements(broker);
  return new Set(rows.map((r) => r.brokerOrderId).filter(Boolean));
}

export async function acknowledgePreExistingOrders(opts: {
  broker: string;
  actor: string;
  reason: string;
  orders: Array<{
    brokerOrderId: string;
    symbol: string;
    side?: string;
    quantity?: number;
    averageFillPrice?: number;
    snapshot?: unknown;
  }>;
}): Promise<{ acknowledged: number; skipped: number; rows: typeof reconciliationAcknowledgements.$inferSelect[] }> {
  const reason = String(opts.reason || '').trim();
  if (reason.length < 8) {
    throw new Error('Acknowledgement reason must be at least 8 characters (operator review required).');
  }
  if (!opts.orders?.length) {
    throw new Error('At least one broker order is required.');
  }

  const now = new Date().toISOString();
  const out: typeof reconciliationAcknowledgements.$inferSelect[] = [];
  let acknowledged = 0;
  let skipped = 0;

  for (const o of opts.orders) {
    const brokerOrderId = String(o.brokerOrderId || '').trim();
    const symbol = String(o.symbol || '').trim().toUpperCase();
    if (!brokerOrderId || !symbol) {
      skipped += 1;
      continue;
    }
    const fingerprint = reconciliationFingerprint({
      broker: opts.broker,
      brokerOrderId,
      symbol,
      quantity: o.quantity,
      averageFillPrice: o.averageFillPrice,
    });

    const existing = await db.select().from(reconciliationAcknowledgements)
      .where(and(
        eq(reconciliationAcknowledgements.broker, opts.broker),
        eq(reconciliationAcknowledgements.brokerOrderId, brokerOrderId),
      ));
    const row0 = existing[0];
    if (row0?.status === ACK_STATUS_ACTIVE) {
      skipped += 1;
      out.push(row0);
      continue;
    }

    if (row0) {
      await db.update(reconciliationAcknowledgements).set({
        symbol,
        side: o.side ?? row0.side,
        quantity: o.quantity ?? row0.quantity,
        averageFillPrice: o.averageFillPrice ?? row0.averageFillPrice,
        status: ACK_STATUS_ACTIVE,
        actor: opts.actor,
        reason,
        fingerprint,
        brokerSnapshotJson: o.snapshot != null ? JSON.stringify(o.snapshot) : row0.brokerSnapshotJson,
        acknowledgedAt: now,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
      }).where(eq(reconciliationAcknowledgements.id, row0.id));
    } else {
      await db.insert(reconciliationAcknowledgements).values({
        broker: opts.broker,
        brokerOrderId,
        symbol,
        side: o.side ?? null,
        quantity: o.quantity ?? null,
        averageFillPrice: o.averageFillPrice ?? null,
        status: ACK_STATUS_ACTIVE,
        actor: opts.actor,
        reason,
        fingerprint,
        brokerSnapshotJson: o.snapshot != null ? JSON.stringify(o.snapshot) : null,
        acknowledgedAt: now,
      });
    }
    acknowledged += 1;
    const [row] = await db.select().from(reconciliationAcknowledgements)
      .where(and(
        eq(reconciliationAcknowledgements.broker, opts.broker),
        eq(reconciliationAcknowledgements.brokerOrderId, brokerOrderId),
      ));
    if (row) out.push(row);
  }

  return { acknowledged, skipped, rows: out };
}

export async function revokeAcknowledgement(opts: {
  broker: string;
  brokerOrderId: string;
  actor: string;
  reason: string;
}): Promise<boolean> {
  const reason = String(opts.reason || '').trim();
  if (reason.length < 4) throw new Error('Revoke reason required.');
  const rows = await db.select().from(reconciliationAcknowledgements)
    .where(and(
      eq(reconciliationAcknowledgements.broker, opts.broker),
      eq(reconciliationAcknowledgements.brokerOrderId, opts.brokerOrderId),
      eq(reconciliationAcknowledgements.status, ACK_STATUS_ACTIVE),
    ));
  if (!rows.length) return false;
  await db.update(reconciliationAcknowledgements).set({
    status: ACK_STATUS_REVOKED,
    revokedAt: new Date().toISOString(),
    revokedBy: opts.actor,
    revokeReason: reason,
  }).where(eq(reconciliationAcknowledgements.id, rows[0].id));
  return true;
}
