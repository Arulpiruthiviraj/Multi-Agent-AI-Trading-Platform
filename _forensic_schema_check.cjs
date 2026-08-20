const Database = require('better-sqlite3');
const db = new Database('data/argus.db', { readonly: true, fileMustExist: true });
for (const t of ['agent_predictions','kronos_predictions','prediction_outcomes']) {
  console.log('---', t, '---');
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log(cols.map(c=>c.name).join(', '));
}
db.close();
