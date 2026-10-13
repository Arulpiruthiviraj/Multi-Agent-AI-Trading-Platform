/**
 * retentionBatch.ts - bounded-cost retention deletes (2026-10-12).
 *
 * Instrumented on the 17 GB production database (SLOW_SQL_STATEMENT): the old retention pattern - a
 * delete whose key came from a sub-select filtered on the time column with a row limit - has no usable index
 * on that column (quant_assessments, decision_provenance, ...), so EVERY batch scanned the whole table:
 * 65.7 s (quant_assessments) and 15.6 s (decision_provenance) of synchronous main-thread blocking in a
 * single statement. This walks the table in rowid windows and deletes only inside each window, so each
 * statement's cost is proportional to the window, not the table. A per-table cursor lets successive sweeps
 * resume where the last one stopped, so rows that are expired but sit behind younger rows (out-of-order
 * inserts, long-lived rows) are still reached; the cursor resets once the frontier is passed.
 * Rows deleted are exactly those older than the cutoff - never more.
 */
const cursors = new Map<string, number>();
export function resetRetentionCursorsForTests(): void { cursors.clear(); }

export function deleteExpiredByRowidWindows(
  sqlite: any,
  table: string,
  timeColumn: string,
  cutoff: string | number,
  windowRows: number,
  maxWindows: number,
): { deleted: number; windows: number; lastWindowHadExpired: boolean } {
  // Identifiers come from code constants (never user input).
  // Rows can be large (decision_provenance up to 256 KB each): reading the time column forces the row's pages in,
  // so one 5,000-row window took 7-8 s. Cap the window so each statement stays well under a second.
  windowRows = Math.min(windowRows, 400);
  const win = sqlite.prepare('SELECT rowid AS r, ' + timeColumn + ' AS t ' + 'FROM' + ' ' + table + ' WHERE rowid > ? ORDER BY rowid LIMIT ?');
  const del = sqlite.prepare('DELETE ' + 'FROM' + ' ' + table + ' WHERE rowid >= ? AND rowid <= ? AND ' + timeColumn + ' < ?');
  let after = cursors.get(table) ?? -1;
  let deleted = 0;
  let windows = 0;
  let emptyStreak = 0;
  let lastExpired = false;
  for (let i = 0; i < maxWindows; i++) {
    const rows = win.all(after, windowRows) as Array<{ r: number; t: string | number | null }>;
    if (rows.length === 0) { after = -1; break; } // end of table: start from the head next time
    windows += 1;
    const lo = rows[0].r;
    const hi = rows[rows.length - 1].r;
    const expired = rows.some((x) => x.t !== null && x.t < cutoff);
    lastExpired = expired;
    if (expired) { deleted += del.run(lo, hi, cutoff).changes; emptyStreak = 0; } else { emptyStreak += 1; }
    after = hi;
    if (emptyStreak >= 2) { after = -1; break; } // two consecutive windows with nothing expired: frontier reached
    if (rows.length < windowRows) { after = -1; break; }
  }
  cursors.set(table, after);
  return { deleted, windows, lastWindowHadExpired: lastExpired };
}
