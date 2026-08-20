const Database = require('better-sqlite3');
const db = new Database('data/argus.db', { readonly: true, fileMustExist: true });

console.log('outcomes for source=agent_predictions AND agent_name=KronosEngine:');
console.log(db.prepare(`
  SELECT COUNT(*) c FROM prediction_outcomes po
  JOIN agent_predictions ap ON po.prediction_id = ap.id
  WHERE po.source_table='agent_predictions' AND ap.agent_name='KronosEngine'
`).get());

console.log('outcomes for source=kronos_predictions:');
console.log(db.prepare(`SELECT COUNT(*) c FROM prediction_outcomes WHERE source_table='kronos_predictions'`).get());

// Check overlap: do KronosEngine agent_predictions rows share trace_id/timestamp with kronos_predictions rows?
console.log('sample KronosEngine agent_predictions rows:');
console.log(db.prepare(`SELECT id, symbol, prediction, confidence, timestamp, trace_id FROM agent_predictions WHERE agent_name='KronosEngine' ORDER BY timestamp DESC LIMIT 5`).all());

console.log('sample kronos_predictions rows:');
console.log(db.prepare(`SELECT id, symbol, prediction, confidence, timestamp, trace_id, transaction_id FROM kronos_predictions ORDER BY timestamp DESC LIMIT 5`).all());

// Are there matching trace_ids between the two?
console.log('trace_id overlap count:');
console.log(db.prepare(`
  SELECT COUNT(*) c FROM agent_predictions ap
  JOIN kronos_predictions kp ON ap.trace_id = kp.trace_id
  WHERE ap.agent_name='KronosEngine' AND ap.trace_id IS NOT NULL
`).get());

db.close();
