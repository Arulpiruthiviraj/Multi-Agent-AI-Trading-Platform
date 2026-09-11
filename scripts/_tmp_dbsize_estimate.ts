import Database from 'better-sqlite3';
const db = new Database('data/argus.db', { readonly: true });

function estimate(table: string, cols: string[]) {
  const sample = db.prepare(`SELECT ${cols.join(',')} FROM "${table}" ORDER BY RANDOM() LIMIT 500`).all() as any[];
  if (sample.length === 0) return { avgBytes: 0, count: 0 };
  let totalBytes = 0;
  for (const row of sample) {
    totalBytes += JSON.stringify(row).length; // rough proxy for row byte size
  }
  const avgBytes = totalBytes / sample.length;
  const countRow = db.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get() as { c: number };
  return { avgBytes, count: countRow.c, estTotalMB: (avgBytes * countRow.c) / 1e6 };
}

console.log('pit_decision_ledger:', estimate('pit_decision_ledger', ['payload_json', 'symbol', 'kind', 'source']));
console.log('candidate_rankings:', estimate('candidate_rankings', ['component_availability', 'weights_used', 'symbol']));
console.log('observability_events:', estimate('observability_events', ['payload', 'message']));
db.close();
