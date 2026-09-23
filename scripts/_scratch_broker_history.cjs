// Scratch, read-only forensic query. Delete after use.
const Database = require('better-sqlite3');
const dbPath = 'C:\\WorkProjects\\Multi-Agent-AI-Trading-Platform\\data\\argus.db';
const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 10000 });

const sinceIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const sinceMs = new Date(sinceIso).getTime();

const rows = db.prepare(`
  SELECT ts, event_type as eventType, message, payload
  FROM observability_events
  WHERE ts >= ?
    AND (event_type LIKE '%BROKER%' OR message LIKE '%broker%' OR event_type LIKE '%ACTIVE_BROKER%')
  ORDER BY ts ASC
`).all(sinceMs);

console.log(`Rows: ${rows.length}`);
for (const r of rows) {
  console.log(new Date(r.ts).toISOString(), r.eventType, r.message);
}
db.close();
