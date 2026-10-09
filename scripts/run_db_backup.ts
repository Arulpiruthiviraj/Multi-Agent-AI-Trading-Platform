/**
 * Operator/remote-ops entrypoint for DB_BACKUP allowlisted job.
 * Wraps DbBackupService.runBackup() - WAL checkpoint + dated copy under data/backups/.
 * Since 2026-10-08 the heavy work (copy, integrity check, checksum, publish) runs in a
 * worker thread; this script just awaits the outcome.
 */
import { dbBackupService } from '../src/server/services/DbBackupService';

try {
  const result = await dbBackupService.runBackup();
  if (result.outcome === 'completed') {
    console.log(`[run_db_backup] Backup verified and complete: ${result.destination} (sha256 ${result.sha256.slice(0, 16)}...)`);
  } else {
    // Disk-preflight skip: deliberate, loud, and observable - not a failure, but the operator
    // must notice (exit 2 distinguishes it from a real backup failure's exit 1).
    console.error(`[run_db_backup] Backup skipped (low disk): ${result.reason}`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error('[run_db_backup] Backup failed:', error);
  process.exitCode = 1;
}
