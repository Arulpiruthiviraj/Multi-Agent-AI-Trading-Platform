const Database = require('better-sqlite3');
const db = new Database('data/argus.db', { readonly: true, fileMustExist: true });
console.log('distinct agent_name:', db.prepare("SELECT agent_name, COUNT(*) c FROM agent_predictions GROUP BY agent_name ORDER BY c DESC").all());
console.log('distinct prediction values (agent_predictions):', db.prepare("SELECT prediction, COUNT(*) c FROM agent_predictions GROUP BY prediction").all());
console.log('distinct prediction values (kronos_predictions):', db.prepare("SELECT prediction, COUNT(*) c FROM kronos_predictions GROUP BY prediction").all());
console.log('distinct outcome values:', db.prepare("SELECT outcome, COUNT(*) c FROM prediction_outcomes GROUP BY outcome").all());
console.log('distinct actual_direction:', db.prepare("SELECT actual_direction, COUNT(*) c FROM prediction_outcomes GROUP BY actual_direction").all());
db.close();
