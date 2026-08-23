/**
 * READ-ONLY hybrid discovery forensic probe. Does not mutate DB or trading state.
 */
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'C:/WorkProjects/Multi-Agent-AI-Trading-Platform';
const dbPath = join(ROOT, 'data/argus.db');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

function section(title: string) {
  console.log(`\n===== ${title} =====`);
}

function safeAll(sql: string, params: unknown[] = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (e) {
    return [{ error: e instanceof Error ? e.message : String(e) }];
  }
}

section('PRAGMA / tables of interest');
console.log(safeAll(
  `SELECT name FROM sqlite_master WHERE type='table' AND (
    name IN ('event_traces','observability_events','agent_reasoning_logs','agent_predictions','ohlcv_bars','config_overrides')
  )`,
));

section('event_traces columns');
console.log(safeAll(`PRAGMA table_info(event_traces)`));

section('observability_events columns');
console.log(safeAll(`PRAGMA table_info(observability_events)`));

section('config_overrides opportunity');
console.log(safeAll(
  `SELECT key, value, updated_at FROM config_overrides WHERE key LIKE '%OPPORTUNITY%' OR key LIKE '%BROAD%' ORDER BY key`,
));

section('event_traces OPPORTUNITY / WATCHLIST last 40');
const etCols = safeAll(`PRAGMA table_info(event_traces)`) as Array<{ name: string }>;
const etNames = new Set(etCols.map((c) => c.name).filter(Boolean));
const typeCol = etNames.has('event_type') ? 'event_type' : etNames.has('type') ? 'type' : null;
const payloadCol = etNames.has('payload') ? 'payload' : etNames.has('data') ? 'data' : etNames.has('envelope') ? 'envelope' : null;
const tsCol = etNames.has('created_at') ? 'created_at' : etNames.has('timestamp') ? 'timestamp' : etNames.has('ts') ? 'ts' : null;
console.log({ typeCol, payloadCol, tsCol, cols: [...etNames] });

if (typeCol) {
  console.log(safeAll(
    `SELECT id, ${typeCol} as event_type, ${tsCol || 'id'} as ts, substr(CAST(${payloadCol || "''"} AS TEXT),1,500) as payload
     FROM event_traces
     WHERE ${typeCol} LIKE '%OPPORTUNITY%' OR ${typeCol} LIKE '%WATCHLIST%' OR ${typeCol} LIKE '%MARKET_DATA%'
     ORDER BY id DESC LIMIT 40`,
  ));
  console.log('\ncounts by type (today-ish last 5k rows):');
  console.log(safeAll(
    `SELECT ${typeCol} as event_type, COUNT(*) as n FROM (
       SELECT ${typeCol} FROM event_traces ORDER BY id DESC LIMIT 5000
     ) GROUP BY ${typeCol} ORDER BY n DESC LIMIT 40`,
  ));
}

section('observability_events recent opportunity / snapshot / hot-swap / symbol limit');
const obsCols = safeAll(`PRAGMA table_info(observability_events)`) as Array<{ name: string }>;
const obsNames = new Set(obsCols.map((c) => c.name));
console.log({ obsCols: [...obsNames] });
const msgCol = obsNames.has('message') ? 'message' : obsNames.has('msg') ? 'msg' : null;
const catCol = obsNames.has('category') ? 'category' : obsNames.has('event_category') ? 'event_category' : null;
const obsTs = obsNames.has('created_at') ? 'created_at' : obsNames.has('timestamp') ? 'timestamp' : 'id';
if (msgCol) {
  console.log(safeAll(
    `SELECT id, ${catCol || "''"} as category, substr(${msgCol},1,240) as message, ${obsTs} as ts
     FROM observability_events
     WHERE ${msgCol} LIKE '%OPPORTUNITY%' OR ${msgCol} LIKE '%Snapshot%' OR ${msgCol} LIKE '%HOT_SWAP%'
        OR ${msgCol} LIKE '%symbol limit%' OR ${msgCol} LIKE '%MarketDataWorker%' OR ${msgCol} LIKE '%OpportunityDiscovery%'
        OR ${msgCol} LIKE '%Pruned%' OR ${msgCol} LIKE '%Subscribed%'
     ORDER BY id DESC LIMIT 50`,
  ));
}

section('agent_predictions last 24h sample by agent/symbol');
console.log(safeAll(
  `SELECT agent, symbol, COUNT(*) as n, MAX(created_at) as last_at
   FROM agent_predictions
   WHERE created_at >= datetime('now', '-1 day')
   GROUP BY agent, symbol
   ORDER BY last_at DESC LIMIT 40`,
));

section('agent_reasoning_logs recent agents');
console.log(safeAll(
  `SELECT agent, COUNT(*) as n, MAX(created_at) as last_at
   FROM agent_reasoning_logs
   WHERE created_at >= datetime('now', '-1 day')
   GROUP BY agent ORDER BY last_at DESC LIMIT 30`,
));

section('agent_reasoning sample for non-anchor symbols');
console.log(safeAll(
  `SELECT id, agent, symbol, substr(CAST(reasoning AS TEXT),1,160) as reasoning, created_at
   FROM agent_reasoning_logs
   WHERE created_at >= datetime('now', '-1 day')
     AND symbol NOT IN ('SPY','QQQ','GLD','NVDA','AAPL','MSFT')
   ORDER BY id DESC LIMIT 25`,
));

section('ohlcv recent symbols');
console.log(safeAll(
  `SELECT symbol, timeframe, COUNT(*) as n, MAX(timestamp) as last_ts
   FROM ohlcv_bars
   GROUP BY symbol, timeframe
   ORDER BY last_ts DESC LIMIT 30`,
));

db.close();

section('runtime session / pid');
for (const p of ['data/.argus_runtime_session.json', 'data/.argus_engine.pid', '.argus_dev.pid']) {
  const full = join(ROOT, p);
  if (existsSync(full)) {
    console.log(p + ':', readFileSync(full, 'utf8').trim().slice(0, 800));
  } else {
    console.log(p + ': MISSING');
  }
}

section('config continuousIntelligence anchors/caps');
const ci = JSON.parse(readFileSync(join(ROOT, 'config/continuousIntelligence.json'), 'utf8'));
console.log({
  maxActiveSubscriptions: ci.maxActiveSubscriptions,
  coreStreamingSymbols: ci.coreStreamingSymbols,
  protectedSymbols: ci.protectedSymbols,
  snapshotScanRthMs: ci.snapshotScanRthMs,
  snapshotScanOffHoursMs: ci.snapshotScanOffHoursMs,
  snapshotTopCandidates: ci.snapshotTopCandidates,
  universeLen: (ci.momentumScanUniverseSymbols || []).length,
  momentumRotationEnabled: ci.momentumRotationEnabled,
});
