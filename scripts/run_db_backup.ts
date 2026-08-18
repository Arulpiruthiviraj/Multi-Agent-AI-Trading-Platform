/**
 * Operator/remote-ops entrypoint for DB_BACKUP allowlisted job.
 * Wraps DbBackupService.runBackup() — WAL checkpoint + dated copy under data/backups/.
 */
import { dbBackupService } from '../src/server/services/DbBackupService';

dbBackupService.runBackup();
console.log('[run_db_backup] Backup complete.');
