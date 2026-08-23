import Database from 'better-sqlite3';

const db = new Database('data/argus.db', { readonly: true, fileMustExist: true });
const settings = db
  .prepare(
    'SELECT selected_broker, trading_state, auto_bot_enabled, emergency_stop_active FROM settings LIMIT 1',
  )
  .get();
console.log(JSON.stringify({ settings }, null, 2));

const tradeCounts = db.prepare('SELECT status, COUNT(*) AS c FROM trades GROUP BY status').all();
console.log(JSON.stringify({ tradeCounts }, null, 2));

const recentNoTrade = db
  .prepare(
    `SELECT type, symbol, substr(CAST(payload AS TEXT), 1, 200) AS p, created_at
     FROM event_traces
     WHERE type IN ('CHIEF_CONSENSUS_COMPLETED', 'WATCHLIST_SUBSCRIBE_REQUESTED', 'OPPORTUNITY_SCAN_COMPLETED', 'TRADE_IDEA_GENERATED', 'RISK_ASSESSMENT_COMPLETED')
     ORDER BY id DESC LIMIT 25`,
  )
  .all();
console.log(JSON.stringify({ recentNoTrade }, null, 2));
db.close();
