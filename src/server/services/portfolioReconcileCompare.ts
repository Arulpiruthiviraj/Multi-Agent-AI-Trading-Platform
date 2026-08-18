/**
 * Position compare helpers for PortfolioReconciliation.
 *
 * Root cause of recurring false MISSING_LOCALLY (GLD/NVDA): reconcile() copied
 * local `portfolio` rows into an in-memory array and compared that snapshot with
 * `h.symbol === pos.symbol` (no canonicalization). A row that landed between that
 * copy and the compare — or a case/whitespace variant of the same ticker — was
 * treated as missing, then the same cycle INSERTed it. `checkedAt` was stamped
 * after a slow `broker.orders()` call (~1.7s), so live `portfolio.last_updated`
 * looked like it already existed before the check. Operators learned to ack-and-resume.
 *
 * Confirm MISSING_LOCALLY with a fresh query (not the snapshot) before recording.
 * Never auto-flatten / auto-resume here.
 */
export function canonicalPortfolioSymbol(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase();
}

export type PositionQtyRow = { symbol: string; quantity: number };

export function summarizePositionSet(
  rows: Array<{ symbol?: unknown; quantity?: number | null }>,
  qtyTolerance: number,
): PositionQtyRow[] {
  const bySymbol = new Map<string, number>();
  for (const row of rows) {
    const symbol = canonicalPortfolioSymbol(row.symbol);
    if (!symbol) continue;
    bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + (Number(row.quantity) || 0));
  }
  return [...bySymbol.entries()]
    .filter(([, quantity]) => quantity > qtyTolerance)
    .map(([symbol, quantity]) => ({ symbol, quantity }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function positionSetDelta(
  remote: PositionQtyRow[],
  local: PositionQtyRow[],
  qtyTolerance: number,
): {
  missingLocally: PositionQtyRow[];
  missingRemotely: PositionQtyRow[];
  qtyDrift: Array<PositionQtyRow & { localQty: number }>;
} {
  const localMap = new Map(local.map((r) => [r.symbol, r.quantity]));
  const remoteMap = new Map(remote.map((r) => [r.symbol, r.quantity]));
  return {
    missingLocally: remote.filter((r) => !localMap.has(r.symbol)),
    missingRemotely: local.filter((r) => !remoteMap.has(r.symbol)),
    qtyDrift: remote.flatMap((r) => {
      const localQty = localMap.get(r.symbol);
      if (localQty == null || Math.abs(localQty - r.quantity) <= qtyTolerance) return [];
      return [{ ...r, localQty }];
    }),
  };
}

export function discrepancyFaultKey(type: string, symbol: string): string {
  return `${type}:${canonicalPortfolioSymbol(symbol)}`;
}

/** Returns true once `key` has been seen `required` times without being pruned. */
export function confirmConsecutiveFault(
  store: Map<string, number>,
  key: string,
  required: number,
): boolean {
  const n = (store.get(key) ?? 0) + 1;
  store.set(key, n);
  return n >= Math.max(1, required);
}

export function pruneResolvedFaults(store: Map<string, number>, liveKeys: Iterable<string>): void {
  const live = new Set(liveKeys);
  for (const key of [...store.keys()]) {
    if (!live.has(key)) store.delete(key);
  }
}

export function findHolding<T extends { symbol: string }>(holdings: T[], symbol: string): T | undefined {
  const canon = canonicalPortfolioSymbol(symbol);
  if (!canon) return undefined;
  return holdings.find((h) => canonicalPortfolioSymbol(h.symbol) === canon);
}

export type MissingLocalVerdict = 'present_matching' | 'present_drift' | 'missing';

/**
 * Snapshot miss is not enough. Re-query local holdings and re-compare before
 * recording MISSING_LOCALLY. Matching qty on the fresh read is a race, not a mismatch.
 */
export async function confirmMissingLocally<T extends { symbol: string; quantity?: number | null }>(
  snapshot: T[],
  symbol: string,
  remoteQty: number,
  qtyTolerance: number,
  // Drizzle's better-sqlite3 query builders are "thenable" (awaitable) but not real Promises -
  // their static return type is the plain array, not Promise<T[]>. Accept both shapes since the
  // real caller (PortfolioReconciliation.ts's loadLocalHoldings) passes the synchronous builder.
  freshQuery: () => T[] | Promise<T[]>,
): Promise<MissingLocalVerdict> {
  const qtyOk = (row: T | undefined) =>
    !!row && Math.abs((row.quantity ?? 0) - remoteQty) <= qtyTolerance;

  const fromSnap = findHolding(snapshot, symbol);
  if (qtyOk(fromSnap)) return 'present_matching';

  const fresh = findHolding(await freshQuery(), symbol);
  if (!fresh) return fromSnap ? 'present_drift' : 'missing';
  if (qtyOk(fresh)) return 'present_matching';
  return 'present_drift';
}

/**
 * Snapshot-held is not enough for MISSING_REMOTELY. Another writer may have
 * already zeroed the row while broker.orders() / account checks ran.
 */
export async function confirmStillHeldLocally<T extends { symbol: string; quantity?: number | null }>(
  snapshot: T[],
  symbol: string,
  qtyTolerance: number,
  freshQuery: () => T[] | Promise<T[]>,
): Promise<boolean> {
  const held = (row: T | undefined) => !!row && (row.quantity ?? 0) > qtyTolerance;
  if (!held(findHolding(snapshot, symbol))) return false;
  return held(findHolding(await freshQuery(), symbol));
}
