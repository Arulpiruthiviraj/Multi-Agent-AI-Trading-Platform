const Database = require('better-sqlite3');
const db = new Database('data/argus.db', { readonly: true });

function section(title) { console.log('\n=== ' + title + ' ==='); }

section('settings (current)');
console.log(db.prepare("SELECT trading_state, auto_bot_enabled, budget, trading_mode, selected_broker, max_trade_size, take_profit_pct, trailing_stop_pct, pipeline_agent_enabled_json FROM settings LIMIT 1").get());

section('kill_switch_events - last 5');
console.log(db.prepare("SELECT from_state, to_state, reason, actor, created_at FROM kill_switch_events ORDER BY id DESC LIMIT 5").all());

section('reconciliation_events - last 5');
console.log(db.prepare("SELECT checked_at, matches, mismatches, worst_impact_dollars, action_taken FROM reconciliation_events ORDER BY id DESC LIMIT 5").all());

section('portfolio (current open positions)');
console.log(db.prepare("SELECT symbol, quantity, average_price FROM portfolio WHERE quantity > 0").all());

section('trades - last 10 (any status)');
console.log(db.prepare("SELECT id, symbol, side, status, price, quantity, reasoning, timestamp FROM trades ORDER BY timestamp DESC LIMIT 10").all());

section('trades - counts by status');
console.log(db.prepare("SELECT status, COUNT(*) c FROM trades GROUP BY status").all());

section('fills - count and last 3');
console.log(db.prepare("SELECT COUNT(*) c FROM fills").get());
console.log(db.prepare("SELECT * FROM fills ORDER BY id DESC LIMIT 3").all());

section('agent_predictions - per-agent last activity (NOW)');
console.log(db.prepare("SELECT agent_name, COUNT(*) c, MAX(timestamp) lastTs FROM agent_predictions GROUP BY agent_name ORDER BY lastTs DESC").all());

section('consensus_decisions - last 24h stats');
console.log(db.prepare("SELECT COUNT(*) c, SUM(approved) approved FROM consensus_decisions WHERE created_at > datetime('now','-1 day')").get());
console.log(db.prepare("SELECT transaction_id, symbol, side, weighted_confidence, approved, reasoning, created_at FROM consensus_decisions ORDER BY created_at DESC LIMIT 5").all());

section('risk_assessments - last 5');
console.log(db.prepare("SELECT trace_id, symbol, side, approved, max_quantity, rejection_gate, created_at FROM risk_assessments ORDER BY created_at DESC LIMIT 5").all());

section('event_traces - most recent event types (last 15)');
console.log(db.prepare("SELECT event_type, source, timestamp FROM event_traces ORDER BY timestamp DESC LIMIT 15").all());

section('news_clusters - freshness');
console.log(db.prepare("SELECT COUNT(*) c, MAX(created_at) lastTs FROM news_clusters WHERE created_at > datetime('now','-1 day')").get());

section('ai_providers - enabled/health snapshot');
console.log(db.prepare("SELECT provider_name, enabled, health, success_rate, last_success, last_failure FROM ai_providers").all());

section('broker_connections');
console.log(db.prepare("SELECT broker_name, paper_mode FROM broker_connections").all());

db.close();
