import Database from 'better-sqlite3';

const db = new Database('data/argus.db', { readonly: true });
const since = Date.now() - 2 * 60 * 60 * 1000;

const preds = db.prepare(
  `SELECT agent_name, symbol, COUNT(*) as n, MAX(timestamp) as last
   FROM agent_predictions
   WHERE timestamp >= datetime('now','-2 hours')
   GROUP BY agent_name, symbol
   ORDER BY n DESC LIMIT 50`,
).all();

const reason = db.prepare(
  `SELECT agent_name, symbol, COUNT(*) as n, MAX(timestamp) as last
   FROM agent_reasoning_logs
   WHERE timestamp >= datetime('now','-2 hours')
   GROUP BY agent_name, symbol
   ORDER BY n DESC LIMIT 40`,
).all();

const hotDynamic = ['COIN', 'MRVL', 'SOFI', 'RIVN', 'ORCL', 'AMD', 'META', 'TSLA'];
const dynamicPreds = db.prepare(
  `SELECT agent_name, symbol, prediction, confidence, timestamp
   FROM agent_predictions
   WHERE timestamp >= datetime('now','-2 hours')
     AND symbol IN (${hotDynamic.map(() => '?').join(',')})
   ORDER BY timestamp DESC LIMIT 40`,
).all(...hotDynamic);

const limitPayloads = db.prepare(
  `SELECT timestamp, event_type, substr(payload,1,220) as payload
   FROM event_traces
   WHERE timestamp > ? AND (payload LIKE '%symbol limit%' OR payload LIKE '%symbol_limit%' OR event_type='MARKET_DATA_DISCONNECTED')
   ORDER BY timestamp DESC LIMIT 15`,
).all(since);

const scanGaps = db.prepare(
  `SELECT timestamp, json_extract(payload,'$.scanned') scanned, json_extract(payload,'$.at') at
   FROM event_traces WHERE event_type='OPPORTUNITY_SCAN_COMPLETED' AND timestamp > ?
   ORDER BY timestamp DESC LIMIT 20`,
).all(since);

console.log(JSON.stringify({ preds, reason, dynamicPreds, limitPayloads, scanGaps }, null, 2));
db.close();
