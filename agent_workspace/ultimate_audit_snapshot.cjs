// Read-only production evidence; writes only this audit's JSON artifact.
const fs = require('node:fs');
const Database = require('better-sqlite3');
const db = new Database('data/argus.db', { readonly: true, fileMustExist: true });
const start = Date.parse('2026-09-18T04:00:00Z');
const cutoff = Date.now();
db.exec('BEGIN');
const all = (sql, ...args) => db.prepare(sql).all(...args);
const output = { start: new Date(start).toISOString(), cutoff: new Date(cutoff).toISOString() };
output.events = all('SELECT event_type,COUNT(*) n FROM event_traces WHERE timestamp>=? AND timestamp<? GROUP BY event_type', start, cutoff);
output.observability = all('SELECT event_type,COUNT(*) n,COUNT(DISTINCT symbol) symbols FROM observability_events WHERE ts>=? AND ts<? GROUP BY event_type', start, cutoff);
output.terminals = all("SELECT symbol,trace_id,payload FROM observability_events WHERE ts>=? AND ts<? AND event_type='CONSENSUS_TERMINAL_REASON'", start, cutoff).map(r=>({...r,payload:JSON.parse(r.payload)}));
output.missing = all("SELECT symbol,trace_id,payload FROM observability_events WHERE ts>=? AND ts<? AND event_type='FRESH_PRICE_WAIT_OUTCOME'", start, cutoff).map(r=>({...r,payload:JSON.parse(r.payload)}));
output.ai = all('SELECT p.provider_name,a.agent,a.status,COUNT(*) n FROM ai_calls a LEFT JOIN ai_providers p ON p.id=a.provider WHERE a.created_at>=? AND a.created_at<? GROUP BY p.provider_name,a.agent,a.status',output.start,output.cutoff);
output.tradingStateEvents = all("SELECT timestamp,payload FROM event_traces WHERE timestamp>=? AND timestamp<? AND event_type='TRADING_STATE_CHANGED'",start,cutoff);
output.execution = {};
for(const [table,column] of [['risk_assessments','created_at'],['trades','timestamp'],['fills','filled_at']]) output.execution[table]=all(`SELECT COUNT(*) n FROM ${table} WHERE ${column}>=? AND ${column}<?`,output.start,output.cutoff)[0].n;
output.backtests = all('SELECT strategy_id,status,COUNT(*) runs,SUM(total_trades) trades,MIN(start_date) earliest,MAX(end_date) latest FROM quant_strategy_backtests GROUP BY strategy_id,status');
output.forecasts = all('SELECT forecast_status,direction,COUNT(*) n,MIN(sample_size) minN,MAX(sample_size) maxN FROM quant_forecasts GROUP BY forecast_status,direction');
output.tables = {};
for(const t of ['strategy_configurations','strategy_candidates','strategy_engine_signals','strategy_engine_backtest_runs','strategy_engine_promotions','research_experiments','portfolio']) output.tables[t]=all(`SELECT COUNT(*) n FROM ${t}`)[0].n;
output.paperTrades = all("SELECT symbol,side,status,timestamp,profit_loss,trace_id,quant_strategy_id FROM trades WHERE execution_environment='PAPER'");
output.schemas = {};
for(const t of ['quant_assessments','agent_predictions','ohlcv_bars','replay_runs']) output.schemas[t]=all(`PRAGMA table_info(${t})`).map(r=>r.name);
db.close();
output.baselines = fs.readdirSync('data/research/runs/baseline').flatMap(id=>{
  const p=`data/research/runs/baseline/${id}/evidence.json`;
  return fs.existsSync(p)?[{path:p,...JSON.parse(fs.readFileSync(p,'utf8'))}]:[];
});
output.strategySources = fs.readdirSync('src/server/quant/strategies').filter(f=>f.endsWith('.ts')&&!f.endsWith('.test.ts')).flatMap(f=>{
  const path=`src/server/quant/strategies/${f}`; const text=fs.readFileSync(path,'utf8');
  if(!text.includes('StrategyDefinition ='))return [];
  return [{path,id:text.match(/id:\s*'([^']+)'/)?.[1],regimes:text.match(/applicableRegimes:\s*(\[[^\]]+\])/)?.[1]??'UNKNOWN',conditionLines:text.split(/\r?\n/).filter(l=>/check\(|stopPrice|targetPrice|const side|features|invalidation/.test(l)).map(l=>l.trim())}];
});
output.modelRegistry = JSON.parse(fs.readFileSync('config/engineOwnership.json','utf8'));
fs.writeFileSync('agent_workspace/ultimate_audit_snapshot.json',JSON.stringify(output,null,2));
console.log(JSON.stringify({cutoff:output.cutoff,events:output.events,execution:output.execution,backtests:output.backtests,baselineEvidence:output.baselines.map(x=>({strategy:x.strategyId,oos:x.oosPass,walkForward:x.walkForwardPass,promotable:x.promotable,gates:x.gateSnapshot})),strategySources:output.strategySources.length},null,2));
