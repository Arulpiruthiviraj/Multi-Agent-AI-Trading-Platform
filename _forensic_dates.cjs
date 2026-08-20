const Database = require('better-sqlite3');
const db = new Database('data/argus.db', { readonly: true, fileMustExist: true });
console.log('agent_predictions timestamp range:', db.prepare("SELECT MIN(timestamp) mn, MAX(timestamp) mx, COUNT(*) c FROM agent_predictions").get());
console.log('kronos_predictions timestamp range:', db.prepare("SELECT MIN(timestamp) mn, MAX(timestamp) mx, COUNT(*) c FROM kronos_predictions").get());
console.log('prediction_outcomes evaluated_at range:', db.prepare("SELECT MIN(evaluated_at) mn, MAX(evaluated_at) mx, COUNT(*) c FROM prediction_outcomes").get());
console.log('prediction_outcomes by source_table:', db.prepare("SELECT source_table, COUNT(*) c FROM prediction_outcomes GROUP BY source_table").all());
console.log('sample agent_predictions timestamps:', db.prepare("SELECT timestamp FROM agent_predictions ORDER BY timestamp DESC LIMIT 5").all());
db.close();
