/**
 * Copy diag-* / DIAG* PENDING trades into diagnostic_trade_archive, then mark ARCHIVED_DIAGNOSTIC.
 * Does not DELETE. Dry-run by default. Pass --apply to mutate.
 *
 * Usage: npx tsx scripts/archive_diagnostic_pending.ts [--apply]
 */
import { sqliteDb, dbPath } from '../src/server/db/index';
import { archiveDiagnosticPendingTrades } from '../src/server/db/archiveDiagnosticPending';

const apply = process.argv.includes('--apply');
console.log(`[archive-diag] db=${dbPath} apply=${apply}`);
const result = archiveDiagnosticPendingTrades(sqliteDb, { apply });
console.log(JSON.stringify(result, null, 2));
if (!apply && result.matched > 0) {
  console.log('[archive-diag] Re-run with --apply to copy then mark ARCHIVED_DIAGNOSTIC. Rows are not deleted.');
}
