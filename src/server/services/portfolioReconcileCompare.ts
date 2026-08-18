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
