// Scratch, read-only forensic query (not part of the app). Opens data/argus.db with
// {readonly:true} - never writes, never competes with the real engine's single WAL writer.
// Delete after use.
const Database = require('better-sqlite3');

const dbPath = 'C:\\WorkProjects\\Multi-Agent-AI-Trading-Platform\\data\\argus.db';
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const rows = db.prepare(`
  SELECT
    ra.trace_id as traceId,
    ra.symbol,
    ra.side,
    ra.approved,
    ra.rejection_gate as rejectionGate,
    ra.created_at as createdAt,
    rgr.detail as gate25Detail,
    rgr.passed as gate25Passed
  FROM risk_assessments ra
  JOIN risk_gate_results rgr ON rgr.trace_id = ra.trace_id
  WHERE rgr.gate_name = 'extended_hours_execution_policy'
    AND ra.created_at >= ?
  ORDER BY ra.created_at ASC
`).all(sinceIso);

console.log(`Total gate-25 evaluations in last 7 days: ${rows.length}`);
console.log(JSON.stringify(rows, null, 2));
db.close();
