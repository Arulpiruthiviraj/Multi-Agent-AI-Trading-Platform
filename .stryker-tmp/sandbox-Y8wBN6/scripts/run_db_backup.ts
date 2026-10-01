/**
 * Operator/remote-ops entrypoint for DB_BACKUP allowlisted job.
 * Wraps DbBackupService.runBackup() — WAL checkpoint + dated copy under data/backups/.
 */
// @ts-nocheck

import { dbBackupService } from '../src/server/services/DbBackupService';

try {
  const destination = await dbBackupService.runBackup();
  console.log(`[run_db_backup] Backup verified and complete: ${destination}`);
} catch (error) {
  console.error('[run_db_backup] Backup failed:', error);
  process.exitCode = 1;
}
