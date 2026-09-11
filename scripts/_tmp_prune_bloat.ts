import Database from 'better-sqlite3';
const db = new Database('data/argus.db'); // NOT readonly - this writes

const now = Date.now();
const cutoffMs = now - 14 * 24 * 60 * 60 * 1000;
const cutoffIso = new Date(cutoffMs).toISOString();
console.log('Cutoff (keep rows newer than):', cutoffIso);

function countAndDelete(table: string, col: string, kind: 'iso' | 'ms') {
  const cutoff = kind === 'iso' ? cutoffIso : cutoffMs;
  const before = (db.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get() as any).c;
  const toDelete = (db.prepare(`SELECT COUNT(*) as c FROM "${table}" WHERE "${col}" < ?`).get(cutoff) as any).c;
  console.log(`${table}: ${before} rows total, ${toDelete} older than cutoff (${((toDelete / before) * 100).toFixed(1)}%)`);
  const info = db.prepare(`DELETE FROM "${table}" WHERE "${col}" < ?`).run(cutoff);
  console.log(`  -> deleted ${info.changes} rows`);
}

countAndDelete('quant_assessments', 'created_at', 'iso');
countAndDelete('event_traces', 'timestamp', 'ms');
countAndDelete('pit_decision_ledger', 'created_at', 'iso');
countAndDelete('agent_reasoning_logs', 'timestamp', 'iso');
countAndDelete('candidate_rankings', 'cycle_at', 'iso');

console.log('Running VACUUM (this rewrites the whole file - will take a while on a large DB)...');
db.exec('VACUUM');
console.log('VACUUM complete.');

const pageCount = db.pragma('page_count', { simple: true }) as number;
const pageSize = db.pragma('page_size', { simple: true }) as number;
const finalBytes = pageCount * pageSize;
console.log('Final DB size bytes:', finalBytes, `(${(finalBytes / 1e9).toFixed(2)} GB)`);

db.close();
