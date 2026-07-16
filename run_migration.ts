import Database from 'better-sqlite3';
const sqlite = new Database('argus.db');
try {
  sqlite.exec('ALTER TABLE trades ADD COLUMN trace_id TEXT;');
  console.log("Migration successful");
} catch(e) {
  console.log("Migration failed or already applied:", e.message);
}
