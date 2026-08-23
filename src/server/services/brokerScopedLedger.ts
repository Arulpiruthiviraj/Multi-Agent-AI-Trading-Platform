/**
 * Broker-scoped trade / order ledger helpers.
 * Trades are the OMS order book; there is no separate `orders` table.
 * Fail-closed: unknown brokerId query params are rejected by callers (400), not remapped.
 */
import { desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { trades, settings } from '../db/schema';

/** Canonical adapter ids used on trades.broker_id and BrokerManager. */
export const KNOWN_BROKER_IDS = new Set([
  'alpaca',
  'ibkr_gateway',
  'ibkr_web',
  'internal_paper',
  'coinbase',
  'historical_replay',
]);

export type BrokerScope = { mode: 'all' } | { mode: 'broker'; brokerId: string };

export function parseBrokerScopeQuery(raw: unknown): BrokerScope | { error: string } {
  if (raw == null || raw === '') return { mode: 'broker', brokerId: '' }; // resolve later = active
  const s = String(raw).trim().toLowerCase();
  if (s === 'all' || s === '*') return { mode: 'all' };
  if (!KNOWN_BROKER_IDS.has(s)) {
    return { error: `Unknown brokerId ${JSON.stringify(raw)}. Use all | alpaca | ibkr_gateway | ibkr_web | internal_paper.` };
  }
  return { mode: 'broker', brokerId: s };
}

/** Persist settings.selectedBroker name → id when live BrokerManager is unavailable. */
export function selectedBrokerNameToId(name: string | null | undefined): string | null {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  if (KNOWN_BROKER_IDS.has(n)) return n;
  if (n.includes('gateway') || n.includes('socket')) return 'ibkr_gateway';
  if (n.includes('web api') || n === 'ibkr_web') return 'ibkr_web';
  if (n.includes('interactive') || n === 'ibkr') return 'ibkr_gateway';
  if (n.includes('alpaca')) return 'alpaca';
  if (n.includes('internal') || n.includes('simulator') || n.includes('paper broker')) return 'internal_paper';
  if (n.includes('coinbase')) return 'coinbase';
  return null;
}

export function readSelectedBrokerIdFromSettings(): string | null {
  try {
    const row = db.select({ selectedBroker: settings.selectedBroker }).from(settings).limit(1).get();
    return selectedBrokerNameToId(row?.selectedBroker ?? null);
  } catch {
    return null;
  }
}

export function resolveActiveBrokerId(liveActiveId?: string | null): string {
  const live = String(liveActiveId || '').trim();
  if (live && KNOWN_BROKER_IDS.has(live)) return live;
  return readSelectedBrokerIdFromSettings() || 'alpaca';
}

export function brokerScopeWhere(scope: BrokerScope, activeBrokerId: string): SQL | undefined {
  if (scope.mode === 'all') return undefined;
  const id = scope.brokerId || activeBrokerId;
  // Treat NULL legacy as alpaca (migration backfill + belt-and-suspenders for unmigrated DBs).
  if (id === 'alpaca') {
    return sql`(${trades.brokerId} = 'alpaca' OR ${trades.brokerId} IS NULL)`;
  }
  return eq(trades.brokerId, id);
}

export async function listTradesForBrokerScope(opts: {
  scope: BrokerScope;
  activeBrokerId: string;
  limit?: number;
}): Promise<typeof trades.$inferSelect[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const where = brokerScopeWhere(opts.scope, opts.activeBrokerId);
  const q = db.select().from(trades).$dynamic();
  const rows = where
    ? await q.where(where).orderBy(desc(trades.timestamp)).limit(limit)
    : await q.orderBy(desc(trades.timestamp)).limit(limit);
  return rows;
}

/** Human label for UI “Viewing: …” header. */
export function brokerViewingLabel(brokerId: string, accountId?: string | null): string {
  const acct = accountId ? ` (${accountId})` : '';
  switch (brokerId) {
    case 'ibkr_gateway':
      return `Interactive Brokers Paper (Gateway)${acct}`;
    case 'ibkr_web':
      return `Interactive Brokers Paper (Web API)${acct}`;
    case 'alpaca':
      return `Alpaca Paper${acct}`;
    case 'internal_paper':
      return `Argus Internal Simulator${acct}`;
    case 'coinbase':
      return `Coinbase${acct}`;
    default:
      return `${brokerId}${acct}`;
  }
}
