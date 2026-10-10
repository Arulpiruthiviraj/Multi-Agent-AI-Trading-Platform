/** Consistent read-only certification copy. Never fall back to independently copied WAL files. */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export async function createCertificationSnapshot(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceFile = resolve(sourcePath);
  const destinationFile = resolve(destinationPath);
  if (sourceFile === destinationFile || existsSync(destinationFile)) throw new Error('SNAPSHOT_DESTINATION_NOT_EMPTY');
  const source = new Database(sourceFile, { readonly: true, fileMustExist: true });
  try {
    source.pragma('query_only=ON');
    source.exec('BEGIN');
    source.prepare('SELECT count(*) FROM sqlite_schema').get(); // Pin the read snapshot.
    await source.backup(destinationFile, { progress: () => 128 });
  } finally {
    if (source.inTransaction) source.exec('ROLLBACK');
    source.close();
  }
}
