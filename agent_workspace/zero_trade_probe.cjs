const Database = require('better-sqlite3');
const fs = require('node:fs');
const db = new Database('data/argus.db', { readonly: true, fileMustExist: true });
const out = {};
for (const t of ['observability_events', 'consensus_decisions', 'consensus_evidence', 'session_lifecycle_snapshots', 'agent_predictions']) {
  out[t] = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
}
out.days = db.prepare("SELECT date(timestamp/1000,'unixepoch','-4 hours') day,count(*) n FROM event_traces GROUP BY day ORDER BY day DESC LIMIT 5").all();
const since = Date.parse('2026-09-17T04:00:00Z');
out.events = db.prepare('SELECT event_type,count(*) n FROM event_traces WHERE timestamp>=? GROUP BY event_type ORDER BY n DESC').all(since);
out.observability = db.prepare('SELECT event_type,count(*) n FROM observability_events WHERE ts>=? GROUP BY event_type ORDER BY n DESC').all(since);
out.ai = db.prepare('SELECT provider,agent,status,count(*) n FROM ai_calls WHERE created_at>=? GROUP BY provider,agent,status').all(new Date(since).toISOString());
out.missing = db.prepare("SELECT * FROM event_traces WHERE timestamp>=? AND event_type='TRADE_IDEA_REJECTED' AND payload LIKE '%MISSING_PRICE%'").all(since);
out.terminals = db.prepare("SELECT * FROM observability_events WHERE ts>=? AND event_type='CONSENSUS_TERMINAL_REASON'").all(since);
out.providers = db.prepare('SELECT id,provider_name,enabled,health FROM ai_providers').all();
out.samples = {};
for (const type of ['IBKR_MARKET_DATA_ERROR','DISCOVERY_CANDIDATE_ADMITTED','SUBSCRIPTION_PROMOTED','SUBSCRIPTION_ALREADY_ACTIVE','MARKET_DATA_DISCONNECTED','TECHNICAL_ANALYSIS_COMPLETED','KRONOS_UNAVAILABLE','KRONOS_STATUS_CHANGE','SYSTEM_METRICS','MARKET_DATA_GAP_DETECTED','TEMPORARY_DATA_RESCUE_DENIED','WATCHLIST_SUBSCRIBE_REQUESTED','UNCLEAN_SHUTDOWN_DETECTED']) {
 out.samples[type] = db.prepare('SELECT ts,symbol,message,payload FROM observability_events WHERE ts>=? AND event_type=? ORDER BY ts DESC LIMIT 2').all(since,type);
}
out.aiErrors = db.prepare('SELECT provider,error,count(*) n FROM ai_calls WHERE created_at>=? AND status!=? GROUP BY provider,error ORDER BY n DESC LIMIT 30').all(new Date(since).toISOString(),'success');
out.execution = {};
for(const [t,col] of [['risk_assessments','created_at'],['trades','timestamp'],['fills','filled_at']]) out.execution[t]=db.prepare(`SELECT count(*) n FROM ${t} WHERE ${col}>=?`).get(new Date(since).toISOString());
fs.writeFileSync('agent_workspace/zero_trade_probe.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({providers:out.providers,samples:out.samples,aiErrors:out.aiErrors,execution:out.execution},null,2));
db.close();
